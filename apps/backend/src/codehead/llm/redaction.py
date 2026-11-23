"""Remove supplied secrets and common credentials without reading any configuration."""

import json
import re

_HEADER_NAMES = r"(?:authorization|proxy-authorization|cookie|set-cookie)"
_CREDENTIAL_NAMES = (
    r"(?:[a-z0-9]+[_-])*(?:api[_-]?key|password|passwd|pwd|secret|"
    r"client[_-]?secret|access[_-]?token|refresh[_-]?token|token|username|user)"
)
_HEADER_KEYS = re.compile(_HEADER_NAMES, re.IGNORECASE)
_CREDENTIAL_KEYS = re.compile(_CREDENTIAL_NAMES, re.IGNORECASE)
_HEADERS = re.compile(
    rf"""(?P<prefix>\b{_HEADER_NAMES}\b["']?[ \t]*[:=][ \t]*)"""
    r"(?P<value>[^\r\n]+)",
    re.IGNORECASE,
)
_SECRET_VALUES = re.compile(
    rf"""(?P<prefix>\b{_CREDENTIAL_NAMES}\b["']?[ \t]*[:=][ \t]*)"""
    r"(?P<value>[^\r\n]+)",
    re.IGNORECASE,
)
_URL_USERINFO = re.compile(r"(?P<scheme>\b[a-z][a-z0-9+.-]*://)[^/\s@?#]+@", re.IGNORECASE)
_BEARER = re.compile(r"(?P<prefix>\bbearer[ \t]+)(?P<value>[^\s]+)", re.IGNORECASE)
_SENSITIVE_BINDINGS = re.compile(
    rf"""\b(?:{_HEADER_NAMES}|{_CREDENTIAL_NAMES})\b["']?[ \t]*[:=][ \t]*"""
    r"|\bbearer[ \t]+",
    re.IGNORECASE,
)
_QUOTED_BINDINGS = re.compile(
    rf"""(?P<prefix>\b(?P<name>{_HEADER_NAMES}|{_CREDENTIAL_NAMES})\b["']?[ \t]*[:=][ \t]*)"""
    r"""(?P<value>"(?:\\(?:[\s\S]|$)|[^"\\])*(?:"|$)|'(?:\\(?:[\s\S]|$)|[^'\\])*(?:'|$))""",
    re.IGNORECASE,
)
_JSON_CONTAINERS = re.compile(r"[\[{]")
_LINE_BREAKS = re.compile(r"[\r\n]")
_COMPLETE_MARKERS = frozenset(
    f"[REDACTED:{reason}]"
    for reason in ("secret", "credentials", "cookies", "authorization", "credential", "bearer")
)


def _mask_value(match: re.Match, reason: str) -> str:
    value = match["value"]
    quote = value[0] if len(value) > 1 and value[0] in ('"', "'") and value[-1] == value[0] else ""
    bare = value[1:-1] if quote else value
    if bare in _COMPLETE_MARKERS:
        return match[0]
    return f"{match['prefix']}{quote}[REDACTED:{reason}]{quote}"


def _redact_plain(text: str, secrets: tuple[str, ...]) -> str:
    for secret in sorted(
        {value for value in secrets if value}, key=lambda value: (-len(value), value)
    ):
        text = text.replace(secret, "[REDACTED:secret]")
    text = _URL_USERINFO.sub(r"\g<scheme>[REDACTED:credentials]@", text)
    text = _HEADERS.sub(
        lambda match: _mask_value(
            match, "cookies" if "cookie" in match["prefix"].lower() else "authorization"
        ),
        text,
    )
    text = _SECRET_VALUES.sub(lambda match: _mask_value(match, "credential"), text)
    return _BEARER.sub(lambda match: _mask_value(match, "bearer"), text)


def _sensitive_name_reason(name) -> str | None:
    if not isinstance(name, str):
        return None
    name = name.strip()
    if _HEADER_KEYS.fullmatch(name):
        return "cookies" if "cookie" in name.lower() else "authorization"
    if _CREDENTIAL_KEYS.fullmatch(name):
        return "credential"
    return None


def _mask_multiline_quoted_binding(match: re.Match) -> str:
    if "\n" not in match["value"] and "\r" not in match["value"]:
        return match[0]
    reason = _sensitive_name_reason(match["name"])
    assert reason is not None
    return _mask_value(match, reason)


def _mask_json_item(item, reason: str):
    return item if isinstance(item, str) and item in _COMPLETE_MARKERS else f"[REDACTED:{reason}]"


def _redact_json(value, secrets: tuple[str, ...]):
    if isinstance(value, str):
        return _redact_text(value, secrets)
    if isinstance(value, list):
        reason = _sensitive_name_reason(value[0]) if len(value) == 2 else None
        if reason:
            return [_redact_text(value[0], secrets), _mask_json_item(value[1], reason)]
        return [_redact_json(item, secrets) for item in value]
    if isinstance(value, dict):
        header_reason = _sensitive_name_reason(value.get("name")) if "value" in value else None
        redacted = {}
        for key, item in value.items():
            reason = (
                header_reason if key == "value" and header_reason else _sensitive_name_reason(key)
            )
            safe_item = _mask_json_item(item, reason) if reason else _redact_json(item, secrets)
            redacted[_redact_plain(key, secrets)] = safe_item
        return redacted
    return value


def _parse_json(text: str, start: int):
    has_duplicates = False

    def collect_pairs(pairs):
        nonlocal has_duplicates
        result = {}
        object_duplicates = False
        header_reason = None
        for key, item in pairs:
            if key in result:
                has_duplicates = True
                object_duplicates = True
            if key == "name":
                header_reason = header_reason or _sensitive_name_reason(item)
            result[key] = item
        # A shadowed header name must not erase an earlier sensitive association.
        if object_duplicates and header_reason and "value" in result:
            result["value"] = _mask_json_item(result["value"], header_reason)
        return result

    parsed, end = json.JSONDecoder(object_pairs_hook=collect_pairs).raw_decode(text, start)
    return parsed, end, has_duplicates


def _render_json(original: str, parsed, duplicates: bool, secrets: tuple[str, ...]) -> str:
    redacted = _redact_json(parsed, secrets)
    if not duplicates and redacted == parsed:
        return original
    # ASCII escapes keep isolated JSON surrogates out of UTF-8 trace text.
    return json.dumps(redacted, ensure_ascii=True)


def _redact_text(text: str, secrets: tuple[str, ...]) -> str:
    start = len(text) - len(text.lstrip())
    if text[start : start + 1] in ("{", "[", '"'):
        try:
            parsed, end, duplicates = _parse_json(text, start)
        except json.JSONDecodeError:
            pass
        else:
            if not text[end:].strip():
                return (
                    text[:start]
                    + _render_json(text[start:end], parsed, duplicates, secrets)
                    + text[end:]
                )

    # Consume complete quoted credentials before a JSON fragment or line can split them.
    text = _QUOTED_BINDINGS.sub(_mask_multiline_quoted_binding, text)
    chunks = []
    cursor = 0
    search_from = 0
    while candidate := _JSON_CONTAINERS.search(text, search_from):
        start = candidate.start()
        line_start = max(
            cursor,
            text.rfind("\n", cursor, start) + 1,
            text.rfind("\r", cursor, start) + 1,
        )
        if _SENSITIVE_BINDINGS.search(text, line_start, start):
            line_break = _LINE_BREAKS.search(text, start)
            end = line_break.start() if line_break else len(text)
            chunks.append(_redact_plain(text[cursor:end], secrets))
            cursor = search_from = end
            continue
        try:
            parsed, end, duplicates = _parse_json(text, start)
        except json.JSONDecodeError:
            search_from = start + 1
            continue
        chunks.append(_redact_plain(text[cursor:start], secrets))
        chunks.append(_render_json(text[start:end], parsed, duplicates, secrets))
        cursor = search_from = end
    chunks.append(_redact_plain(text[cursor:], secrets))
    return "".join(chunks)


def redact(text: str, secrets: tuple[str, ...] = ()) -> str:
    """Redact complete credential values and JSON without emitting invalid UTF-8."""
    redacted = _redact_text(text, secrets)
    return redacted.encode("utf-8", errors="backslashreplace").decode("utf-8")
