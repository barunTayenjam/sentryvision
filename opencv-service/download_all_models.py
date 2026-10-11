#!/usr/bin/env python3
"""
Comprehensive model downloader for SentryVision OpenCV Service
Downloads YOLOv8, YOLOv5, and face recognition models
"""

import os
import sys
import urllib.request
import urllib.error
import hashlib
import json
from pathlib import Path

# Configuration
MODELS_DIR = os.path.join(os.path.dirname(__file__), 'models')
DOWNLOAD_TIMEOUT = 300  # 5 minutes timeout

# Model definitions with URLs and checksums (when available)
MODELS = {
    # YOLOv8s ONNX - Better accuracy for scene understanding (preferred)
    'yolov8s.onnx': {
        'urls': [
            "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8s.onnx",
        ],
        'description': 'YOLOv8 Small ONNX - Best accuracy for scene understanding',
        'size_mb': 43.0,
        'required': False
    },

    # YOLOv8n ONNX - Fast fallback
    'yolov8n.onnx': {
        'urls': [
            "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8n.onnx",
        ],
        'description': 'YOLOv8 Nano ONNX - Fast fallback',
        'size_mb': 6.0,
        'required': False
    },
    
    # CrowdHuman QAT INT8 person detector (1-class, 640x384) — select with
    # YOLO_MODEL=crowdhuman_qat_640x384
    'crowdhuman_qat_640x384.onnx': {
        'urls': [
            "https://huggingface.co/ru551n/inblick-yolov8n/resolve/main/crowdhuman_qat_640x384/qdq.onnx",
        ],
        'description': 'CrowdHuman QAT INT8 person detector - person-specialised, 16:9 input',
        'size_mb': 3.3,
        'required': False
    },

    # CrowdHuman QAT v8s backbone — primary person detector (recall 0.884
    # vs 0.864 v8n on 3115 AI-labeled events). YOLO_MODEL=crowdhuman_v8s_qat_640x384
    'crowdhuman_v8s_qat_640x384.onnx': {
        'urls': [
            "https://huggingface.co/ru551n/inblick-yolov8n/resolve/main/crowdhuman_v8s_qat_640x384/qdq.onnx",
        ],
        'description': 'CrowdHuman QAT v8s person detector - highest person recall',
        'size_mb': 11.5,
        'required': False
    },

    # COCO QAT INT8 (80-class, 640x384) — dual-chain aux for
    # vehicles/animals. QAT_AUX=coco_qat
    'coco_qat_640x384.onnx': {
        'urls': [
            "https://huggingface.co/ru551n/inblick-yolov8n/resolve/main/coco_qat_640x384/qdq.onnx",
        ],
        'description': 'COCO QAT INT8 detector - vehicles/animals aux, 16:9 input',
        'size_mb': 3.5,
        'required': False
    },

    # all-MiniLM-L6-v2 INT8 ONNX (384-dim text embeddings) — semantic search
    # over events. Served by /embed; falls back to hash vectors when absent.
    'minilm_l6_int8.onnx': {
        'urls': [
            "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx",
        ],
        'description': 'all-MiniLM-L6-v2 INT8 ONNX - 384-dim sentence embeddings',
        'size_mb': 23.0,
        'required': False
    },

    # Tokenizer for the MiniLM embedder (HuggingFace tokenizers format)
    'minilm_tokenizer.json': {
        'urls': [
            "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json",
        ],
        'description': 'MiniLM tokenizer.json (wordpiece, 256 token limit)',
        'size_mb': 0.7,
        'required': False
    },

    # YOLOv5n ONNX - Good alternative
    'yolov5n.onnx': {
        'urls': [
            "https://github.com/ultralytics/yolov5/releases/download/v7.0/yolov5n.onnx",
        ],
        'description': 'YOLOv5 Nano ONNX - Fast detection',
        'size_mb': 4.0,
        'required': False  # Optional backup
    },
    
    # DNN Face detector - Better accuracy than Haar cascades
    'res10_300x300_ssd_iter_140000_fp16.caffemodel': {
        'urls': [
            "https://github.com/opencv/opencv_3rdparty/raw/dnn_samples_face_detector_20170830/res10_300x300_ssd_iter_140000_fp16.caffemodel",
            "https://raw.githubusercontent.com/opencv/opencv_3rdparty/dnn_samples_face_detector_20170830/res10_300x300_ssd_iter_140000_fp16.caffemodel",
        ],
        'description': 'DNN Face Detection Model',
        'size_mb': 5.4,
        'required': False  # Optional fallback, YOLOv8n handles detection
    },

    'deploy.prototxt': {
        'urls': [
            "https://github.com/opencv/opencv/raw/master/samples/dnn/face_detector/deploy.prototxt",
            "https://raw.githubusercontent.com/opencv/opencv/master/samples/dnn/face_detector/deploy.prototxt",
        ],
        'description': 'DNN Face Detector Config',
        'size_mb': 0.03,
        'required': False  # Optional fallback
    },

    'face_detection_yunet_2023mar.onnx': {
        'urls': [
            "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
        ],
        'description': 'YuNet Face Detector (primary — runs at native res, catches small faces)',
        'size_mb': 0.23,
        'required': True
    },
}

# COCO class names (80 classes)
COCO_CLASSES = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
    "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat",
    "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack",
    "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball",
    "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
    "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
    "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake",
    "chair", "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop",
    "mouse", "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier",
    "toothbrush"
]

def print_header(text):
    print("=" * 70)
    print(f"  {text}")
    print("=" * 70)

def print_success(text):
    print(f"✓ {text}")

def print_error(text):
    print(f"✗ {text}")

def print_info(text):
    print(f"  {text}")

def create_directory():
    """Create models directory if it doesn't exist"""
    os.makedirs(MODELS_DIR, exist_ok=True)
    print_info(f"Models directory: {MODELS_DIR}")

def download_with_progress(url, destination, timeout=DOWNLOAD_TIMEOUT):
    """Download file with progress bar"""
    try:
        print_info(f"Downloading from: {url}")
        
        def progress_hook(count, block_size, total_size):
            percent = int(count * block_size * 100 / total_size) if total_size > 0 else 0
            sys.stdout.write(f"\r  Progress: {min(100, percent)}% ({count * block_size / (1024*1024):.1f} MB)")
            sys.stdout.flush()
        
        urllib.request.urlretrieve(url, destination, reporthook=progress_hook)
        print()  # New line after progress
        return True
    except urllib.error.URLError as e:
        print()
        print_info(f"Failed: {e}")
        return False
    except Exception as e:
        print()
        print_info(f"Error: {e}")
        return False

def verify_file_size(filepath, expected_size_mb, tolerance=0.5):
    """Verify downloaded file size is approximately correct"""
    if not os.path.exists(filepath):
        return False
    
    actual_size_mb = os.path.getsize(filepath) / (1024 * 1024)
    size_diff = abs(actual_size_mb - expected_size_mb)
    
    if size_diff > tolerance:
        print_error(f"File size mismatch: expected ~{expected_size_mb}MB, got {actual_size_mb:.1f}MB")
        return False
    
    return True

def download_model(model_name, model_info):
    """Download a single model"""
    filepath = os.path.join(MODELS_DIR, model_name)
    
    # Check if file already exists
    if os.path.exists(filepath):
        if verify_file_size(filepath, model_info['size_mb']):
            size_mb = os.path.getsize(filepath) / (1024 * 1024)
            print_success(f"{model_name} already exists ({size_mb:.1f} MB)")
            return True
        else:
            print_info(f"Existing file corrupted, re-downloading...")
            os.remove(filepath)
    
    # Try each URL
    for url in model_info['urls']:
        print_info(f"Attempting: {model_info['description']}")
        if download_with_progress(url, filepath):
            # Verify file size
            if verify_file_size(filepath, model_info['size_mb']):
                size_mb = os.path.getsize(filepath) / (1024 * 1024)
                print_success(f"Downloaded {model_name} ({size_mb:.1f} MB)")
                return True
            else:
                print_error(f"Download verification failed, removing file...")
                os.remove(filepath)
    
    return False

def save_class_names():
    """Save COCO class names to file"""
    class_names_path = os.path.join(MODELS_DIR, 'yolo_classes.txt')
    
    if os.path.exists(class_names_path):
        with open(class_names_path, 'r') as f:
            existing_classes = f.read().strip().split('\n')
            if len(existing_classes) >= 80:
                print_success(f"Class names file already exists with {len(existing_classes)} classes")
                return
    
    with open(class_names_path, 'w') as f:
        for name in COCO_CLASSES:
            f.write(name + '\n')
    print_success(f"Saved {len(COCO_CLASSES)} COCO class names to {class_names_path}")

def save_metadata():
    """Save model metadata for reference"""
    metadata_path = os.path.join(MODELS_DIR, 'models_metadata.json')
    
    metadata = {
        'downloaded_at': None,  # Will be set below
        'models': {}
    }
    
    for model_name, info in MODELS.items():
        filepath = os.path.join(MODELS_DIR, model_name)
        if os.path.exists(filepath):
            metadata['models'][model_name] = {
                'downloaded': True,
                'size_bytes': os.path.getsize(filepath),
                'size_mb': os.path.getsize(filepath) / (1024 * 1024),
                'description': info['description']
            }
        else:
            metadata['models'][model_name] = {
                'downloaded': False,
                'description': info['description'],
                'urls': info['urls']
            }
    
    from datetime import datetime
    metadata['downloaded_at'] = datetime.now().isoformat()
    
    with open(metadata_path, 'w') as f:
        json.dump(metadata, f, indent=2)
    
    print_success(f"Saved model metadata to {metadata_path}")

def main():
    print_header("SentryVision - Model Downloader")
    
    # Create directory
    create_directory()
    
    # Save class names
    save_class_names()
    print()
    
    # Download models
    print_header("Downloading Models")
    
    success_count = 0
    required_count = 0
    optional_count = 0
    required_success = 0
    
    for model_name, model_info in MODELS.items():
        if model_info['required']:
            required_count += 1
            print_info(f"[REQUIRED] {model_info['description']}")
        else:
            optional_count += 1
            print_info(f"[OPTIONAL] {model_info['description']}")
        
        if download_model(model_name, model_info):
            success_count += 1
            if model_info['required']:
                required_success += 1
        else:
            if model_info['required']:
                print_error(f"Failed to download required model: {model_name}")
            else:
                print_info(f"Skipped optional model: {model_name}")
        
        print()
    
    # Save metadata
    save_metadata()
    
    # Summary
    print_header("Download Summary")
    print_success(f"Total models downloaded: {success_count}/{len(MODELS)}")
    print_info(f"Required models: {required_success}/{required_count}")
    print_info(f"Optional models: {success_count - required_success}/{optional_count}")
    
    # Check critical models
    critical_models = ['yolov8s.onnx', 'yolov8n.onnx', 'res10_300x300_ssd_iter_140000_fp16.caffemodel', 'deploy.prototxt']
    all_critical = all(os.path.exists(os.path.join(MODELS_DIR, m)) for m in critical_models)
    
    print()
    if all_critical:
        print_success("All critical models downloaded successfully!")
        print_info("Your OpenCV service is ready for:")
        print_info("  - Object detection (YOLOv8)")
        print_info("  - Motion detection (MOG2/KNN)")
        print_info("  - Face detection (DNN-based)")
    else:
        print_error("Some critical models are missing!")
        print_info("The service will still work with fallback methods, but accuracy will be reduced.")
        missing = [m for m in critical_models if not os.path.exists(os.path.join(MODELS_DIR, m))]
        print_info(f"Missing models: {', '.join(missing)}")
    
    print()
    print_info("Next steps:")
    print_info("  1. Build/restart the OpenCV service container")
    print_info("  2. Test detection endpoints")
    print_info("  3. Adjust sensitivity thresholds as needed")
    
    return 0

if __name__ == "__main__":
    sys.exit(main())
