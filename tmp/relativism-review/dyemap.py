from PIL import Image, ImageDraw
from collections import Counter
p='tmp/relativism-review/2827297288_hun_exotic_prism_class_gbit_128_64_3.img'
im=Image.open(p).convert('RGBA'); print(im.size);print(Counter(im.getdata()).most_common(18));
o=Image.new('RGB',(1024,512));o.paste(im.convert('RGB').resize((512,256)),(0,0));o.paste(im.getchannel('A').resize((512,256)),(512,0));o.paste(im.convert('RGB').resize((512,256),Image.Resampling.NEAREST),(0,256));o.save('tmp/relativism-review/dyemap.png')
