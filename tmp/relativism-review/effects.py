from PIL import Image,ImageDraw
from pathlib import Path
r=Path('tmp/relativism-review'); files=[p for p in r.glob('*.img') if any(s in p.name for s in ['warpmap','darkness','blob'])]
o=Image.new('RGB',(768,280*((len(files)+2)//3)));d=ImageDraw.Draw(o)
for i,p in enumerate(files):
 im=Image.open(p).convert('RGB'); im.thumbnail((256,256));x=(i%3)*256;y=(i//3)*280;o.paste(im,(x,y+24));d.text((x,y),p.stem.split('_',1)[1],fill='white')
o.save(r/'effects.png')
