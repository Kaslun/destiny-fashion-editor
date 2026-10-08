from PIL import Image, ImageDraw
from pathlib import Path
root=Path('tmp/relativism-review')
files=list(root.glob('*gbit*.img'))
out=Image.new('RGB',(1024, len(files)*280))
d=ImageDraw.Draw(out)
for i,f in enumerate(files):
 im=Image.open(f).convert('RGBA');im.thumbnail((512,256));out.paste(im.convert('RGB'),(0,i*280+24));d.text((0,i*280),f.stem,fill='white')
 if f.stem.endswith('_2'):
  im=Image.open(f).convert('RGBA').getchannel('B');im.thumbnail((512,256));out.paste(im,(512,i*280+24));d.text((512,i*280),'Blue channel',fill='white')
out.save(root/'atlas.png')

