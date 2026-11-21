#!/usr/bin/env python3
"""Sign catalogue.json so the app accepts it (S3). Run it where the private key lives (your phone
in Termux: `pkg install python python-cryptography`, or a computer: `pip install cryptography`).

  catalogue_sign.py --new-key   make the keys, once:
                                - key 1 (everyday) is saved to KEY, and its public half to
                                  catalogue.pub in this repo (other people's apps read it when
                                  they add this repo as a source);
                                - key 2 (backup) is only printed, never saved: it's for the day
                                  key 1 is lost or leaks;
                                - both private keys are printed for your password manager, and
                                  the last line names both public keys (PUBLIC_KEYS <1> <2>) for
                                  the app's core/plugins.odin.
  catalogue_sign.py             sign: writes catalogue.json.sig next to catalogue.json
  catalogue_sign.py --backup    sign with key 2, pasted when asked (key 1 lost)

KEY is ~/.promptpipe/catalogue.key, or PP_CATALOGUE_KEY=<file>."""
import base64, getpass, os, sys
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY = os.environ.get("PP_CATALOGUE_KEY") or os.path.expanduser("~/.promptpipe/catalogue.key")
RAW = serialization.Encoding.Raw


def secret_hex(key):
    return key.private_bytes(RAW, serialization.PrivateFormat.Raw, serialization.NoEncryption()).hex()


def public_hex(key):
    return key.public_key().public_bytes(RAW, serialization.PublicFormat.Raw).hex()


if "--new-key" in sys.argv:
    if os.path.exists(KEY):
        sys.exit(f"{KEY} already exists; move it away first if you really want new keys")
    os.makedirs(os.path.dirname(KEY), exist_ok=True)
    main, backup = Ed25519PrivateKey.generate(), Ed25519PrivateKey.generate()
    fd = os.open(KEY, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.write(fd, secret_hex(main).encode() + b"\n")
    os.close(fd)
    with open(os.path.join(ROOT, "catalogue.pub"), "w") as f:
        f.write(public_hex(main) + "\n")
    print("Store these two lines in your password manager (each is a private key):")
    print(f"  promptpipe catalogue key 1 (everyday): {secret_hex(main)}")
    print(f"  promptpipe catalogue key 2 (backup):   {secret_hex(backup)}")
    print(f"Key 1 is also saved to {KEY}; key 2 is nowhere else. catalogue.pub is written: commit it.")
    print(f"PUBLIC_KEYS {public_hex(main)} {public_hex(backup)}")
    sys.exit(0)

if "--backup" in sys.argv:
    key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(getpass.getpass("Key 2 (backup): ").strip()))
elif os.path.exists(KEY):
    key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(open(KEY).read().strip()))
else:
    sys.exit(f"No key at {KEY}: run with --new-key first, or put key 1 from your password manager there")
data = open(os.path.join(ROOT, "catalogue.json"), "rb").read()
with open(os.path.join(ROOT, "catalogue.json.sig"), "w") as f:
    f.write(base64.b64encode(key.sign(data)).decode() + "\n")
print("catalogue.json.sig written; commit it with catalogue.json")
