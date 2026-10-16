import FormData from 'form-data';
import { getOpenCVClient } from '../opencvMicroserviceClient.js';

export interface KnownFace {
  id: string;
  name: string;
  count: number;
}

/** Enroll a face image (buffer from a saved event snapshot) under a name.
 * OpenCV /train-face writes the image into known_faces/<name>/ and retrains
 * ArcFace — live recognizer picks it up within seconds. */
export async function enrollFace(
  image: Buffer,
  personName: string,
): Promise<{ success: boolean }> {
  const form = new FormData();
  form.append('image', image, 'face.jpg');
  form.append('personName', personName);

  const res = await getOpenCVClient().post('/train-face', form, {
    headers: form.getHeaders(),
  });
  return res.data as { success: boolean };
}

export async function listKnownFaces(): Promise<{ success: boolean; faces: KnownFace[]; count: number }> {
  const res = await getOpenCVClient().post('/known-faces', {}, {});
  return res.data as { success: boolean; faces: KnownFace[]; count: number };
}
