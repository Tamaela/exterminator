# Generates the shield icons in icons/ (pure Python, no dependencies).
# Usage: python3 tools/make-icons.py icons [store-icon.png]
# The optional second path gets the Chrome Web Store icon: 128 x 128 with the shield inside
# the central 96 x 96, as the store guidelines ask.
import struct, zlib, sys, os, math
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
store = sys.argv[2] if len(sys.argv) > 2 else None
GREEN=(26,127,55); WHITE=(255,255,255)
def inside_shield(x,y):
    if y<0.08 or y>0.94: return False
    if y<0.55:
        hw=0.36 - 0.04*max(0,(0.2-y))/0.12  # slightly narrower top corners
        return abs(x-0.5)<=hw
    t=(y-0.55)/0.39
    return abs(x-0.5)<=0.36*math.sqrt(max(0,1-t*t))
def seg_dist(px,py,ax,ay,bx,by):
    dx,dy=bx-ax,by-ay; t=max(0,min(1,((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy)))
    return math.hypot(px-ax-t*dx,py-ay-t*dy)
def check(x,y,w):
    return min(seg_dist(x,y,0.33,0.50,0.45,0.63),seg_dist(x,y,0.45,0.63,0.68,0.37))<=w
def png(size, scale=1.0):
    ss=4; rows=[]
    w=0.065 if size>=32 else 0.09
    for j in range(size):
        row=bytearray([0])
        for i in range(size):
            acc=[0,0,0,0]
            for sj in range(ss):
                for si in range(ss):
                    x=(i+(si+.5)/ss)/size; y=(j+(sj+.5)/ss)/size
                    x=(x-0.5)/scale+0.5; y=(y-0.51)/scale+0.51  # 0.51: the shield's vertical centre
                    if inside_shield(x,y):
                        c=WHITE if check(x,y,w) else GREEN
                        acc[0]+=c[0];acc[1]+=c[1];acc[2]+=c[2];acc[3]+=255
            n=ss*ss; a=acc[3]
            if a: row+=bytes([acc[0]*255//a,acc[1]*255//a,acc[2]*255//a,a//n])
            else: row+=bytes(4)
        rows.append(bytes(row))
    def chunk(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(rows),9))+chunk(b'IEND',b'')
for s in (16,32,48,128):
    open(os.path.join(out,f'icon{s}.png'),'wb').write(png(s))
if store:
    os.makedirs(os.path.dirname(store) or '.', exist_ok=True)
    open(store,'wb').write(png(128, scale=0.75/0.86))  # shield height 0.86 -> 96 of 128 px
