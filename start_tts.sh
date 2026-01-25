# Local only, no docker
#!/bin/bash

cd tts-service

if [ ! -d "LuxTTS" ]; then
    echo "Cloning LuxTTS..."
    git clone https://github.com/ysharma3501/LuxTTS.git
fi

if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

source venv/bin/activate

echo "Installing requirements..."
pip install -r requirements.txt

echo "Starting TTS Server..."
python server.py
