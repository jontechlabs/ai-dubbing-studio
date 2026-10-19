"""CPU-only face proposals. Never identifies the speaker or modifies video."""
import argparse
import json
import math
from pathlib import Path
import sys

def plain(value):
    value = str(value)
    return '\\\\' + value[8:] if value.startswith('\\\\?\\UNC\\') else value[4:] if value.startswith('\\\\?\\') else value

def iou(a, b):
    intersection = max(0, min(a[0]+a[2], b[0]+b[2])-max(a[0], b[0])) * max(0, min(a[1]+a[3], b[1]+b[3])-max(a[1], b[1]))
    return intersection / max(1e-9, a[2]*a[3]+b[2]*b[3]-intersection)

def normalized_boxes(faces, width, height):
    result=[]
    for x,y,w,h in faces:
        if not all(math.isfinite(v) for v in (x,y,w,h)):continue
        left=max(0,x);top=max(0,y);right=min(width,x+w);bottom=min(height,y+h)
        if right-left>=24 and bottom-top>=24:
            result.append((left/width,top/height,(right-left)/width,(bottom-top)/height))
    return result

def propose(detections, cuts=False):
    if cuts:
        return dict(crop=None, reason='FACE_SCENE_CHANGE')
    if any(len(rows)>1 for rows in detections):
        return dict(crop=None, reason='FACE_MULTIPLE')
    # Missing frames are deliberately not guessed across a shot or an occlusion.
    if len(detections)!=5 or any(len(rows)!=1 for rows in detections):
        return dict(crop=None, reason='FACE_NOT_FOUND')
    boxes=[rows[0] for rows in detections]
    if any(len(b)<4 or any(not math.isfinite(v) for v in b[:4]) or b[2]<=0 or b[3]<=0 or b[0]<0 or b[1]<0 or b[0]+b[2]>1.00001 or b[1]+b[3]>1.00001 for b in boxes):
        raise ValueError('FACE_RESULT_INVALID')
    times=[.1,.3,.5,.7,.9]
    widths=[b[2] for b in boxes]; heights=[b[3] for b in boxes]
    if max(widths)/min(widths)>1.35 or max(heights)/min(heights)>1.35:
        return dict(crop=None, reason='FACE_MOVEMENT')
    def fit(values):
        mean=sum(values)/5
        slope=sum((t-.5)*(v-mean) for t,v in zip(times,values))/.4
        start=mean-.5*slope
        if max(abs(v-(start+t*slope)) for t,v in zip(times,values))>.12*min(max(widths),max(heights)):
            return None
        return start, start+slope
    x=fit([b[0]+b[2]/2 for b in boxes]);y=fit([b[1]+b[3]/2 for b in boxes])
    if x is None or y is None:
        return dict(crop=None, reason='FACE_MOVEMENT')
    w=min(1,max(widths)*1.4);h=min(1,max(heights)*1.4)
    left=max(0,min(1-w,x[0]-w/2));top=max(0,min(1-h,y[0]-h/2))
    end_x=max(0,min(1-w,x[1]-w/2));end_y=max(0,min(1-h,y[1]-h/2))
    # Reject boundary-clamping trajectories which would exclude any sampled face.
    if any(b[0]<left+(end_x-left)*t-.002 or b[1]<top+(end_y-top)*t-.002 or b[0]+b[2]>left+(end_x-left)*t+w+.002 or b[1]+b[3]>top+(end_y-top)*t+h+.002 for t,b in zip(times,boxes)):
        return dict(crop=None, reason='FACE_MOVEMENT')
    return dict(crop=dict(face=dict(x=left,y=top,width=w,height=h),endX=end_x,endY=end_y,mask=dict(x=.2,y=.55,width=.6,height=.4)),reason=None)

class Detector:
    def __init__(self, root, profile):
        import cv2
        import numpy as np
        self.cv=cv2;self.profile=profile
        cv2.setNumThreads(1)
        # OpenCV's filename overloads do not support all Windows Unicode paths.
        # Python owns all file I/O; OpenCV receives in-memory model buffers.
        data=np.frombuffer((Path(root)/'yunet.onnx').read_bytes(),dtype=np.uint8)
        self.yunet=cv2.FaceDetectorYN.create('onnx',data,np.empty(0,dtype=np.uint8),(320,320),.85,.3,5000,cv2.dnn.DNN_BACKEND_OPENCV,cv2.dnn.DNN_TARGET_CPU)
        storage=cv2.FileStorage((Path(root)/'anime.xml').read_text(encoding='utf-8'),cv2.FILE_STORAGE_READ|cv2.FILE_STORAGE_MEMORY)
        self.anime=cv2.CascadeClassifier()
        self.anime.read(storage.getFirstTopLevelNode())
        storage.release()
        if self.anime.empty():
            raise ValueError('FACE_RUNTIME_FAILED')
    def detect(self, image):
        cv=self.cv;h,w=image.shape[:2];faces=[]
        if self.profile in ['auto','live']:
            self.yunet.setInputSize((w,h))
            found=self.yunet.detect(image)[1]
            if found is not None:
                faces=[tuple(map(float,row[:4])) for row in found]
        if self.profile in ['auto','anime']:
            gray=cv.equalizeHist(cv.cvtColor(image,cv.COLOR_BGR2GRAY))
            for box in self.anime.detectMultiScale(gray,scaleFactor=1.1,minNeighbors=5,minSize=(24,24)):
                b=tuple(map(float,box))
                if not any(iou(b,old)>.35 for old in faces):faces.append(b)
        return normalized_boxes(faces,w,h)
    def analyze(self, folder):
        import numpy as np
        cv=self.cv
        images=[cv.imdecode(np.fromfile(plain(Path(folder)/f'{i:06}.png'),dtype=np.uint8),cv.IMREAD_COLOR) for i in range(5)]
        if any(image is None for image in images):raise ValueError('FACE_RESULT_INVALID')
        cuts=False
        thumbs=[cv.cvtColor(cv.resize(image,(48,32)),cv.COLOR_BGR2GRAY).astype('float32')/255 for image in images]
        hist=[cv.calcHist([cv.cvtColor(image,cv.COLOR_BGR2HSV)],[0,1],None,[24,16],[0,180,0,256]) for image in images]
        for h in hist:cv.normalize(h,h)
        for a,b,ha,hb in zip(thumbs,thumbs[1:],hist,hist[1:]):
            if float(np.mean(np.abs(a-b)))>.22 and cv.compareHist(ha,hb,cv.HISTCMP_BHATTACHARYYA)>.45:cuts=True
        return propose([self.detect(image) for image in images],cuts)

def main():
    p=argparse.ArgumentParser();p.add_argument('--info',action='store_true');p.add_argument('--request');args=p.parse_args()
    import cv2
    if args.info:
        print(json.dumps(dict(runtimeReady=cv2.__version__=='4.11.0',device='CPU',version=cv2.__version__)),flush=True);return
    r=json.loads(Path(args.request).read_text(encoding='utf-8-sig'))
    if r.get('profile') not in ['auto','anime','live']:raise ValueError('FACE_PROFILE_INVALID')
    result=Detector(r['models'],r['profile']).analyze(r['inputDirectory'])
    Path(r['output']).write_text(json.dumps(result),encoding='utf-8')
    print(json.dumps(dict(stage='faceDetection',progress=1)),flush=True)

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps(dict(error=str(error))),flush=True);raise
