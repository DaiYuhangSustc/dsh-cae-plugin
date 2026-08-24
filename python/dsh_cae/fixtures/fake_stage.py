"""Fake stage exercising every runner path; run as `python -m dsh_cae.fixtures.fake_stage`."""
import argparse
import sys
import time


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True)
    args = parser.parse_args()
    if args.mode == "ok":
        print("noise line before receipt")
        print("<<<DSH_CAE_JSON>>>")
        print('{"ok": true, "value": 42}')
        return
    if args.mode == "fail":
        print("boom: kernel exploded", file=sys.stderr)
        sys.exit(1)
    if args.mode == "sleep":
        time.sleep(30)
        return
    if args.mode == "no-receipt":
        print("just talking, no receipt")
        return


if __name__ == "__main__":
    main()
