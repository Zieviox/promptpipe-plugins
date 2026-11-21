#!/usr/bin/env python3
"""Sign catalogue.json so the app accepts it (S3). Meant to run on your phone (Termux:
`pkg install python python-cryptography`), where the private key lives.

  catalogue_sign.py --new-key   make the key: the private key goes to KEY (outside any repo; keep
                                a copy in your password manager), and the public key is printed,
                                to go into PUBLIC_KEYS in the app's core/plugins.odin
  catalogue_sign.py             sign: writes catalogue.json.sig next to catalogue.json

KEY is ~/.promptpipe/catalogue.key, or PP_CATALOGUE_KEY=<file>."""
import base64, os, sys
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY = os.environ.get("PP_CATALOGUE_KEY") or os.path.expanduser("~/.promptpipe/catalogue.key")
RAW = serialization.Encoding.Raw

if "--new-key" in sys.argv:
    if os.path.exists(KEY):
        sys.exit(f"{KEY} already exists; move it away first if you really want a new key")
    os.makedirs(os.path.dirname(KEY), exist_ok=True)
    key = Ed25519PrivateKey.generate()
    secret = key.private_bytes(RAW, serialization.PrivateFormat.Raw, serialization.NoEncryption())
    fd = os.open(KEY, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.write(fd, secret.hex().encode() + b"\n")
    os.close(fd)
    print(f"Private key written to {KEY}. Copy this line into your password manager:\n{secret.hex()}\n")
    print("Public key, for PUBLIC_KEYS in core/plugins.odin:")
    print(key.public_key().public_bytes(RAW, serialization.PublicFormat.Raw).hex())
    sys.exit(0)

if not os.path.exists(KEY):
    sys.exit(f"No key at {KEY}: run with --new-key first, or put the copy from your password manager there")
key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(open(KEY).read().strip()))
data = open(os.path.join(ROOT, "catalogue.json"), "rb").read()
with open(os.path.join(ROOT, "catalogue.json.sig"), "w") as f:
    f.write(base64.b64encode(key.sign(data)).decode() + "\n")
print("catalogue.json.sig written; commit both files")
