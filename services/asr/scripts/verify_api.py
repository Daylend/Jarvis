"""Quick API verification for moonshine-voice create_stream().
Run inside the ASR container AFTER entrypoint.sh has sourced the env:
  docker exec paxfax-asr bash -c 'source /app/models/moonshine.env && python /app/scripts/verify_api.py'

Or more robust: try to source the env file from within Python.
"""
import os
import subprocess
import sys

from moonshine_voice import Transcriber, ModelArch

# Try to load the env vars from moonshine.env (entrypoint.sh sources it)
if "MOONSHINE_MODEL_PATH" not in os.environ:
    env_file = "/app/models/moonshine.env"
    if os.path.isfile(env_file):
        # Load env vars from the file
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, val = line.partition("=")
                    os.environ[key] = val
    else:
        print("ERROR: /app/models/moonshine.env not found. Run entrypoint.sh first.")
        sys.exit(1)

model_path = os.environ.get("MOONSHINE_MODEL_PATH", "")
model_arch = int(os.environ.get("MOONSHINE_MODEL_ARCH", "0"))

if not model_path:
    print("ERROR: MOONSHINE_MODEL_PATH not set")
    sys.exit(1)

print(f"Model path: {model_path}")
print(f"Model arch: {model_arch}")

t = Transcriber(
    model_path=model_path,
    model_arch=ModelArch(model_arch),
    update_interval=0.25,
    options={"return_audio_data": "false", "identify_speakers": "false"},
)

# Check what stream-related methods exist
stream_methods = [m for m in dir(t) if 'stream' in m.lower() or 'create' in m.lower()]
print(f"Transcriber stream methods: {stream_methods}")

has_create_stream = hasattr(t, 'create_stream')
print(f"has create_stream: {has_create_stream}")

if has_create_stream:
    import inspect
    try:
        src = inspect.getsource(t.create_stream)
        print(f"create_stream source:\n{src[:600]}")
    except Exception as e:
        print(f"create_stream source error: {e}")

    print("\nAttempting create_stream()...")
    stream = t.create_stream(update_interval=0.25)
    print(f"Stream type: {type(stream)}")
    print(f"Stream public methods: {[m for m in dir(stream) if not m.startswith('_')]}")

    for method in ["add_listener", "add_audio", "start", "stop"]:
        has = hasattr(stream, method)
        print(f"stream.{method}: {'✓' if has else '✗ MISSING!'}")

    if hasattr(stream, "stop"):
        stream.stop()
else:
    print("\n!!! create_stream NOT FOUND — fall back to Transcriber pool approach")

t.stop()
print("\nDone.")
