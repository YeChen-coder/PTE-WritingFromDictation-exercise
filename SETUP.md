# Setup

This project is a local PTE Writing From Dictation practice app. It uses only
Python standard-library modules, so there is no package install step.

## Requirements

- Python 3.10 or newer
- A folder of numbered MP3 prompt files
- A numbered answer text file

The audio files and answer file are not included in this repository. Add your
own local materials before running the app.

## Material Format

Audio files should be named by question number:

```text
materials/audio/1.mp3
materials/audio/2.mp3
materials/audio/3.mp3
```

The answer file should contain one numbered sentence per line:

```text
1. This is the correct answer for question one.
2. This is the correct answer for question two.
3. This is the correct answer for question three.
```

By default, the server looks for:

```text
materials/audio/
materials/answers.txt
```

You can also keep the materials anywhere else and pass their paths at launch.

## Run on Windows

From the project root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\launch_wfd_trainer.ps1" `
  -AudioDir "C:\path\to\your\audio-folder" `
  -AnswerFile "C:\path\to\your\answers.txt"
```

The launcher starts the local server and opens:

```text
http://127.0.0.1:8765/
```

To use a different port:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\launch_wfd_trainer.ps1" `
  -Port 8780 `
  -AudioDir "C:\path\to\your\audio-folder" `
  -AnswerFile "C:\path\to\your\answers.txt"
```

## Run Directly with Python

From the project root:

```powershell
python .\server.py `
  --audio-dir "C:\path\to\your\audio-folder" `
  --answer-file "C:\path\to\your\answers.txt" `
  --open-browser
```

If you place materials in the default local folders, this shorter command also
works:

```powershell
python .\server.py --open-browser
```

## Local Data

The app stores practice progress, wrong-question records, drafts, and settings
in the browser's `localStorage`. These records are local to the browser profile
and are not uploaded anywhere by this app.

Reward sound MP3 files are optional and are intentionally not committed. If you
want feedback sounds, place compatible files at:

```text
app/assets/feedback-correct-v2.mp3
app/assets/feedback-wrong.mp3
```
