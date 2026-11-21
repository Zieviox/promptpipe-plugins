#!/usr/bin/env python3
"""Write catalogue.json: every plugin folder in this repo with its name, version, tags, minimum
app version, path, built-in flag and the SHA-256 of each of its files (plugin.json and the files
it lists). The app checks each downloaded file against these (S3); catalogue_sign.py signs the
result. Run it after changing any plugin, from anywhere."""
import hashlib, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOT_BUILT_IN = set()  # every plugin here ships in the APK today; list ids to leave one out
MIN_APP = "1.0.0"

entries = []
for folder in sorted(os.listdir(ROOT)):
    manifest_path = os.path.join(ROOT, folder, "plugin.json")
    if not os.path.isfile(manifest_path):
        continue
    manifest = json.load(open(manifest_path, encoding="utf-8"))
    names = ["plugin.json", *manifest.get("files", [])]
    hashes = {n: hashlib.sha256(open(os.path.join(ROOT, folder, n), "rb").read()).hexdigest() for n in names}
    entries.append({
        "id": manifest["id"],
        "name": manifest["name"],
        "version": manifest["version"],
        "description": manifest.get("description", ""),
        "tags": manifest.get("tags", []),
        "min_app": manifest.get("min_app", MIN_APP),
        "path": folder,
        "built_in": manifest["id"] not in NOT_BUILT_IN,
        "hashes": hashes,
    })

out = os.path.join(ROOT, "catalogue.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump({"version": 1, "entries": entries}, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"catalogue.json: {len(entries)} plugins; sign it with scripts/catalogue_sign.py")
