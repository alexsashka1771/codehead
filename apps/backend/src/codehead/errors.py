"""Safe domain failures suitable for HTTP and future worker consumers."""


class DomainError(Exception):
    def __init__(self, code: str, message: str, *, status: int = 409, retriable: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.retriable = retriable
