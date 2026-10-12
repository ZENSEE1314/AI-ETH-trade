# Kronos forecast microservice — CPU inference of the Kronos candlestick model.
FROM python:3.11-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Vendor the Kronos model code (the `model/` package the app imports).
RUN git clone --depth 1 https://github.com/shiyu-coder/Kronos.git /app/Kronos
ENV PYTHONPATH=/app/Kronos

# CPU-only torch (smaller image than the CUDA wheel) + the model + server deps.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir \
      numpy "pandas==2.2.2" "einops==0.8.1" "huggingface_hub==0.33.1" \
      "safetensors==0.6.2" "tqdm==4.67.1" fastapi "uvicorn[standard]"

COPY app.py /app/app.py

ENV KRONOS_DEVICE=cpu
# Cache HF weights on the writable layer so a restart doesn't re-download.
ENV HF_HOME=/app/.hf
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
