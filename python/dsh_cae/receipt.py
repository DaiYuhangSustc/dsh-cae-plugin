"""Shared receipt emission for every dsh_cae stage."""
import json
import sys

MARK = "<<<DSH_CAE_JSON>>>"


def emit(obj: dict) -> None:
    """Print the receipt marker and one JSON object as the stage's final stdout."""
    print(MARK)
    print(json.dumps(obj))
    sys.stdout.flush()


def fail(message: str) -> None:
    """Report an infrastructure failure: marker JSON on stderr, exit code 1."""
    print(MARK, file=sys.stderr)
    print(json.dumps({"error": message}), file=sys.stderr)
    sys.stderr.flush()
    sys.exit(1)
