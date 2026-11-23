"""Print the canonical public JSON Schema without filesystem side effects."""

import json

from codehead.contracts import ContractBundle


def main() -> None:
    print(json.dumps(ContractBundle.model_json_schema(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
