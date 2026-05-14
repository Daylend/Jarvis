"""Quick API verification for moonshine-voice create_stream().
Run inside the ASR container:
  docker exec paxfax-asr python /app/verify_api.py
"""
from moonshine_voice import Transcriber, ModelArch
import os

# Use the model path from the env
model_path = os.environ["MOONSHINE_MODEL_PATH"]
model_arch = int(os.environ["MOONSHINE_MODEL_ARCH"])

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
        print(f"create_stream signature:\n{src[:500]}")
    except Exception as e:
        print(f"create_stream source error: {e}")
    
    # Try creating a stream
    print("\nAttempting create_stream()...")
    stream = t.create_stream(update_interval=0.25)
    print(f"Stream type: {type(stream)}")
    print(f"Stream methods: {[m for m in dir(stream) if not m.startswith('_')]}")
    
    has_add_listener = hasattr(stream, 'add_listener')
    has_add_audio = hasattr(stream, 'add_audio')
    has_start = hasattr(stream, 'start')
    has_stop = hasattr(stream, 'stop')
    print(f"stream.add_listener: {has_add_listener}")
    print(f"stream.add_audio: {has_add_audio}")
    print(f"stream.start: {has_start}")
    print(f"stream.stop: {has_stop}")
else:
    print("\n!!! create_stream NOT FOUND — fall back to Transcriber pool approach")
