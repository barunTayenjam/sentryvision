from flask import Blueprint, request, jsonify
import os
import time

import state

face_bp = Blueprint('face', __name__)


@face_bp.route('/train-face', methods=['POST'])
def train_face():
    try:
        if state.face_recognition is None:
            return jsonify({'success': False, 'error': 'Face recognition not available'}), 503

        if 'image' not in request.files:
            return jsonify({'success': False, 'error': 'No image file provided'}), 400

        image_file = request.files['image']
        person_name = request.form.get('personName')

        if not person_name:
            return jsonify({
                'success': False,
                'error': 'personName is required'
            }), 400

        person_dir = os.path.join(state.face_recognition.known_faces_dir, person_name)
        if not os.path.exists(person_dir):
            os.makedirs(person_dir)

        timestamp = int(time.time() * 1000)
        filename = f"{timestamp}_{image_file.filename}" if image_file.filename else f"{timestamp}.jpg"
        dest_path = os.path.join(person_dir, filename)

        image_file.save(dest_path)

        state.face_recognition.train_recognizer()

        return jsonify({
            'success': True,
            'message': f'Face for {person_name} added and model retrained'
        })
    except Exception as e:
        print(f"OpenCV Service: Face training error: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@face_bp.route('/retrain-model', methods=['POST'])
def retrain_model():
    try:
        if state.face_recognition is None:
            return jsonify({'success': False, 'error': 'Face recognition not available'}), 503
        state.face_recognition.train_recognizer()
        return jsonify({
            'success': True,
            'message': 'Face recognition model retrained successfully'
        })
    except Exception as e:
        print(f"OpenCV Service: Model retraining error: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@face_bp.route('/known-faces', methods=['GET', 'POST'])
def get_known_faces():
    try:
        if state.face_recognition is None:
            return jsonify({'success': True, 'faces': [], 'count': 0})
        faces = []
        if state.face_recognition.is_trained:
            names_set = set(state.face_recognition.known_names_512 + state.face_recognition.known_names_128)
            for idx, name in enumerate(sorted(names_set)):
                faces.append({
                    'id': str(idx),
                    'name': name
                })

        return jsonify({
            'success': True,
            'faces': faces,
            'count': len(faces)
        })
    except Exception as e:
        print(f"OpenCV Service: Get known faces error: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500
