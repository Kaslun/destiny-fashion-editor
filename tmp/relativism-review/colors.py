from PIL import Image
from collections import Counter
im=Image.open('tmp/relativism-review/2827297288_hun_exotic_prism_class_gbit_128_64_3.img').convert('RGBA')
c=Counter()
for r,g,b,a in im.get_flattened_data():
 if max(r,g,b)-min(r,g,b)<32 and min(r,g,b)<128<=max(r,g,b):c[(r,g,b)]+=1
print(c.most_common(25))
