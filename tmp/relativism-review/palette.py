from PIL import Image
im=Image.open('public/textures/iridescence-lookup.png');print(im.mode,im.size)
for y in [0,1,2,3,4,5,127]:print(y,[im.getpixel((x,y)) for x in [0,16,32,48,63]])
im.crop((0,0,64,6)).resize((1024,192),Image.Resampling.NEAREST).save('tmp/relativism-review/palette.png')
