"""Provider data contracts without persistence or implicit inference."""

from dataclasses import dataclass

from codehead.contracts import FileProposal
from codehead.llm.redaction import redact


@dataclass(frozen=True)
class ProviderRequest:
    role: str
    project_name: str
    description: str
    requirements_version: int
    inputs: tuple[dict, ...]
    max_output_tokens: int = 2048
    candidate_files: tuple[dict, ...] = ()
    profile_version: str | None = None
    profile_hash: str | None = None
    acceptance_suite_hash: str | None = None
    quality_context: dict | None = None
    repair_context: dict | None = None
    delivery_context: dict | None = None


@dataclass(frozen=True)
class ArtifactDraft:
    artifact_type: str
    content: str
    media_type: str = "text/markdown"


@dataclass(frozen=True)
class ProviderResult:
    artifacts: tuple[ArtifactDraft, ...]
    summary: str
    raw_response: str
    stop_reason: str
    request_id: str | None
    input_tokens: int | None
    output_tokens: int | None
    cost_usd: float | None
    latency_ms: float
    files: tuple[FileProposal, ...] = ()


class ProviderFailure(Exception):
    """A safe diagnostic that distinguishes dispatch from confirmed execution."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        dispatched: bool = False,
        uncertain: bool = False,
        raw_response: str | None = None,
        stop_reason: str | None = None,
    ):
        self.code = code
        self.message = redact(message)
        self.dispatched = dispatched
        self.uncertain = uncertain
        self.raw_response = redact(raw_response) if raw_response is not None else None
        self.stop_reason = stop_reason
        super().__init__(self.message)


class LiveProviderUnavailable:
    """Keep an unconfigured live run explicit; never fall back to fixtures."""

    name = "unconfigured"
    model = None

    def prepare(self, request: ProviderRequest) -> str:
        raise ProviderFailure(
            "provider_unavailable", "Live LLM provider and model are not configured."
        )

    def run(self, request: ProviderRequest) -> ProviderResult:
        raise ProviderFailure(
            "provider_unavailable", "Live LLM provider and model are not configured."
        )
