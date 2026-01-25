import sys
import os
import uuid
import torch
import torchaudio
from flask import Flask, request, send_file, jsonify, after_this_request

# Add LuxTTS to path
sys.path.append(os.path.join(os.path.dirname(__file__), 'LuxTTS'))

try:
    from zipvoice.luxvoice import LuxTTS
except ImportError as e:
    print(f"Error importing LuxTTS: {e}")
    print("Make sure you have installed the requirements and cloned the repo correctly.")
    sys.exit(1)

app = Flask(__name__)

# Initialize model
device = 'cuda' if torch.cuda.is_available() else 'cpu'
print(f"Loading LuxTTS on {device}...")
try:
    lux_tts = LuxTTS('YatharthS/LuxTTS', device=device, threads=2)
    print("LuxTTS loaded.")
except Exception as e:
    print(f"Failed to load LuxTTS: {e}")
    lux_tts = None

VOICES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'voices')
os.makedirs(VOICES_DIR, exist_ok=True)

@app.route('/generate', methods=['POST'])
def generate():
    if not lux_tts:
        return jsonify({'error': 'Model not loaded'}), 503

    data = request.json
    text = data.get('text')
    voice_filename = data.get('voice')
    
    if not text:
        return jsonify({'error': 'No text provided'}), 400
    
    if not voice_filename:
        return jsonify({'error': 'No voice provided'}), 400
        
    voice_path = os.path.join(VOICES_DIR, voice_filename)
    if not os.path.exists(voice_path):
        return jsonify({'error': 'Voice file not found'}), 404

    try:
        # Encode prompt
        encoded_prompt = lux_tts.encode_prompt(voice_path)
        
        # Generate
        final_wav = lux_tts.generate_speech(text, encoded_prompt)
        
        # Save to temp file
        output_filename = f"output_{uuid.uuid4()}.wav"
        output_path = os.path.join(os.path.dirname(__file__), output_filename)
        
        if isinstance(final_wav, torch.Tensor):
             if final_wav.dim() == 1:
                 final_wav = final_wav.unsqueeze(0)
             torchaudio.save(output_path, final_wav.cpu(), 48000)
        else:
             # Assume numpy
             t = torch.from_numpy(final_wav)
             if t.dim() == 1:
                 t = t.unsqueeze(0)
             torchaudio.save(output_path, t, 48000)

        @after_this_request
        def remove_file(response):
            try:
                os.remove(output_path)
            except Exception as error:
                app.logger.error("Error removing or closing downloaded file handle", error)
            return response

        return send_file(output_path, mimetype="audio/wav")
        
    except Exception as e:
        print(e)
        return jsonify({'error': str(e)}), 500

@app.route('/voices', methods=['GET'])
def list_voices():
    files = [f for f in os.listdir(VOICES_DIR) if f.endswith(('.wav', '.mp3', '.ogg', '.flac'))]
    return jsonify({'voices': files})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
