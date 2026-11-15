"""Put the hosted editor on a Hugging Face Space (free tier, Docker).

    python deploy/space.py                      # only builds scratch/space/: exactly what would be uploaded
    python deploy/space.py <user>/<space-name>  # creates the Space if needed and uploads that folder

The upload needs `pip install huggingface_hub` and a login (`hf auth login`, or HF_TOKEN set to a token with
write access). The Space then builds the Dockerfile; the editor is at https://<user>-<space-name>.hf.space
"""
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "scratch" / "space"


def stage():
    """Only what the container needs: the server, the page, and the six practice images."""
    sys.path.insert(0, str(ROOT))
    from editor_backend import PRACTICE

    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)
    for f in [*ROOT.glob("*.py"), ROOT / "requirements.txt", ROOT / "Dockerfile"]:
        shutil.copy2(f, OUT / f.name)
    shutil.copytree(ROOT / "viewer", OUT / "viewer")
    (OUT / "data" / "tissue_2k").mkdir(parents=True)
    (OUT / "data" / "practice").mkdir()
    sources = json.loads((ROOT / "data" / "tissue_2k" / "SOURCES.json").read_text())
    for src in PRACTICE:
        shutil.copy2(ROOT / "data" / "tissue_2k" / f"{src}.png", OUT / "data" / "tissue_2k" / f"{src}.png")
        shutil.copy2(ROOT / "data" / "practice" / f"{src}_prob.png", OUT / "data" / "practice" / f"{src}_prob.png")
    shutil.copy2(ROOT / "data" / "tissue_2k" / "SOURCES.json", OUT / "data" / "tissue_2k" / "SOURCES.json")
    shutil.copy2(ROOT / "deploy" / "space_README.md", OUT / "README.md")
    files = [p for p in OUT.rglob("*") if p.is_file()]
    print(f"{OUT}: {len(files)} files, {sum(p.stat().st_size for p in files) / 1e6:.0f} MB "
          f"(largest {max(p.stat().st_size for p in files) / 1e6:.1f} MB), {len(sources)} image licences listed")


def upload(repo):
    from huggingface_hub import HfApi          # handles large and binary files itself

    api = HfApi()
    api.create_repo(repo, repo_type="space", space_sdk="docker", exist_ok=True)
    api.upload_folder(folder_path=str(OUT), repo_id=repo, repo_type="space", delete_patterns="*",
                      commit_message="Segmentation editor")
    user, name = repo.split("/")
    print(f"Uploaded. Build log: https://huggingface.co/spaces/{repo}\n"
          f"Editor (send this link): https://{user.lower()}-{name.lower().replace('_', '-')}.hf.space")


if __name__ == "__main__":
    stage()
    if len(sys.argv) > 1:
        upload(sys.argv[1])
    else:
        print("Nothing uploaded. To deploy: python deploy/space.py <user>/<space-name>")
