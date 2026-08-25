from __future__ import annotations

import argparse
import json
import re
import webbrowser
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


PROJECT_ROOT = Path(__file__).resolve().parent
APP_DIR = PROJECT_ROOT / "app"
DEFAULT_AUDIO_DIR = PROJECT_ROOT / "materials" / "audio"
DEFAULT_ANSWER_FILE = PROJECT_ROOT / "materials" / "answers.txt"
ANSWER_PATTERN = re.compile(r"^(\d+)\.\s+(.*)$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve the local PTE Core WFD trainer.")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind the local server to.")
    parser.add_argument("--port", type=int, default=8765, help="Port to bind the local server to.")
    parser.add_argument(
        "--audio-dir",
        default=str(DEFAULT_AUDIO_DIR),
        help="Directory containing numbered MP3 files.",
    )
    parser.add_argument(
        "--answer-file",
        default=str(DEFAULT_ANSWER_FILE),
        help="Text file containing numbered answer sentences.",
    )
    parser.add_argument(
        "--open-browser",
        action="store_true",
        help="Open the trainer automatically in the default browser.",
    )
    return parser.parse_args()


def parse_answer_file(answer_file: Path) -> dict[int, str]:
    content = answer_file.read_text(encoding="utf-8-sig")
    answers: dict[int, str] = {}
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        match = ANSWER_PATTERN.match(line)
        if not match:
            continue
        question_number = int(match.group(1))
        answers[question_number] = match.group(2).strip()
    return answers


def build_dataset(answer_file: Path, audio_dir: Path) -> dict:
    if not answer_file.exists():
        raise FileNotFoundError(f"Answer file not found: {answer_file}")
    if not audio_dir.exists():
        raise FileNotFoundError(f"Audio directory not found: {audio_dir}")

    answers = parse_answer_file(answer_file)
    audio_files = {
        int(path.stem): path
        for path in audio_dir.glob("*.mp3")
        if path.stem.isdigit()
    }

    usable_numbers = sorted(set(answers).intersection(audio_files))
    if not usable_numbers:
        raise RuntimeError("No matching question numbers were found between the answers file and audio directory.")

    missing_audio = sorted(set(answers).difference(audio_files))
    missing_answers = sorted(set(audio_files).difference(answers))

    items = [
        {
            "id": number,
            "promptNumber": number,
            "answer": answers[number],
            "audioUrl": f"/audio/{audio_files[number].name}",
            "audioFileName": audio_files[number].name,
        }
        for number in usable_numbers
    ]

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {
            "audioDirectory": str(audio_dir),
            "answerFile": str(answer_file),
        },
        "warnings": {
            "missingAudio": missing_audio,
            "missingAnswers": missing_answers,
        },
        "items": items,
    }


class TrainerRequestHandler(SimpleHTTPRequestHandler):
    server_version = "PteWfdTrainer/1.0"

    def __init__(self, *args, directory: str | None = None, **kwargs) -> None:
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/items":
            self._serve_json(self.server.dataset)
            return

        if path == "/health":
            self._serve_json({"status": "ok", "items": len(self.server.dataset["items"])})
            return

        if path.startswith("/audio/"):
            self._serve_audio(path.removeprefix("/audio/"))
            return

        if path == "/":
            self.path = "/index.html"

        super().do_GET()

    def _serve_json(self, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _serve_audio(self, raw_name: str) -> None:
        file_name = unquote(raw_name)
        audio_path = self.server.audio_lookup.get(file_name)
        if audio_path is None or not audio_path.exists():
            self.send_error(HTTPStatus.NOT_FOUND, "Audio file not found.")
            return

        file_size = audio_path.stat().st_size
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(file_size))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with audio_path.open("rb") as handle:
            self.copyfile(handle, self.wfile)

    def log_message(self, format: str, *args) -> None:
        timestamp = datetime.now().strftime("%H:%M:%S")
        print(f"[{timestamp}] {self.address_string()} - {format % args}")


class TrainerServer(ThreadingHTTPServer):
    dataset: dict
    audio_lookup: dict[str, Path]


def main() -> None:
    args = parse_args()
    answer_file = Path(args.answer_file)
    audio_dir = Path(args.audio_dir)

    dataset = build_dataset(answer_file, audio_dir)
    audio_lookup = {
        item["audioFileName"]: audio_dir / item["audioFileName"]
        for item in dataset["items"]
    }

    server = TrainerServer((args.host, args.port), TrainerRequestHandler)
    server.dataset = dataset
    server.audio_lookup = audio_lookup

    url = f"http://{args.host}:{args.port}"
    print(f"Serving trainer at {url}")
    print(f"Audio directory: {audio_dir}")
    print(f"Answer file: {answer_file}")
    if dataset["warnings"]["missingAudio"] or dataset["warnings"]["missingAnswers"]:
        print("Warnings:")
        print(f"  Missing audio numbers: {dataset['warnings']['missingAudio']}")
        print(f"  Missing answer numbers: {dataset['warnings']['missingAnswers']}")

    if args.open_browser:
        webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping trainer server...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
