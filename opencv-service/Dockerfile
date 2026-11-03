# ---- Build stage ----
FROM python:3.11-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    g++ gcc \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install --no-cache-dir "uniface[cpu]"
# uniface pulls opencv-python, mediapipe pulls opencv-contrib-python,
# albumentations pulls opencv-python-headless — four dists stomp each
# other's cv2/ and cv2 ends up missing attrs (CascadeClassifier).
# Normalize to exactly one dist: contrib headless.
RUN pip uninstall -y opencv-python opencv-python-headless opencv-contrib-python || true \
    && pip install --no-cache-dir --no-deps --force-reinstall "opencv-contrib-python-headless>=4.8.0,<5"

# ---- Runtime stage ----
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    libgl1-mesa-dri \
    libglx-mesa0 \
    libglib2.0-0 \
    intel-media-va-driver \
    i965-va-driver \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

WORKDIR /app
COPY --from=builder /usr/local/lib/python3.11/site-packages/ /usr/local/lib/python3.11/site-packages/
COPY --from=builder /usr/local/bin/ /usr/local/bin/

COPY . .

# Download models for better detection accuracy
RUN python3 download_all_models.py

EXPOSE 8084
EXPOSE 9090

CMD ["python", "-u", "-m", "flask", "--app", "app", "run", "--host", "0.0.0.0", "--port", "8084"]
