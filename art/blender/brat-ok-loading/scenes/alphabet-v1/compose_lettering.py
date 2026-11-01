"""Paste into Blender's Text Editor and run to compose from the existing library.

The .blend already has BRAT_OK/StarCraft/Loading example groups. This helper does
not register an addon or auto-run on opening the file. It uses immutable library
meshes/materials, makes independent object instances and supports A-Z/a-z/_/space.
"""
import bpy

def compose_lettering(text, x=0, y=0, z=5, size=1, tracking=0, scene=None):
    if not isinstance(text,str) or not 1<=len(text)<=64 or size<=0:
        raise ValueError('Use 1..64 characters and a positive size.')
    library=bpy.data.scenes.get('BRAT_OK — библиотека латинских букв')
    if library is None:
        raise RuntimeError('Open or append the BRAT_OK letter library first.')
    glyphs={o['glyph_char']:o for o in library.objects if o.get('glyph_char')}
    unsupported=sorted(set(text)-set(glyphs)-{' '})
    if unsupported:
        raise ValueError('Missing glyphs: '+', '.join(unsupported))
    target=scene if scene is not None else bpy.context.scene
    root=bpy.data.objects.new('Надпись '+text,None)
    target.collection.objects.link(root)
    root.location=(x,y,z)
    root['text']=text
    root['library']='BRAT_OK painted Latin assets'
    cursor=0
    for index,char in enumerate(text):
        if char==' ':
            cursor+=.9*size+tracking
            continue
        glyph=glyphs[char]
        letter=bpy.data.objects.new('Надпись '+str(index)+' '+char,glyph.data)
        target.collection.objects.link(letter)
        letter.parent=root
        letter.location=(cursor,0,0)
        letter.scale=(size,size,size)
        cursor+=glyph['glyph_advance']*size+tracking
    root['advance']=cursor
    return root

# Example usage after running this file:
# compose_lettering('Your Text', x=-7, y=0, z=5, size=.75, tracking=.04)
