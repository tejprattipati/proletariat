import { expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { initialTheme, ThemeSelector } from '../../src/components/ThemeSelector';
it('reads only the supplied account theme and never adopts another user browser preference',()=>{
  const getItem=vi.fn(()=>JSON.stringify({id:'rust',hue:21,scale:.9}));vi.stubGlobal('localStorage',{getItem});
  try{
    expect(initialTheme({id:'blue',hue:213,scale:.92}).id).toBe('blue');expect(initialTheme()).toMatchObject({id:'green',hue:83,scale:1});
    expect(initialTheme({id:'custom',hue:280,scale:.85})).toMatchObject({id:'custom',hue:280});
    expect(initialTheme({id:'custom',hue:900,scale:.85}).id).toBe('green');
    expect(renderToString(<ThemeSelector value={{id:'blue',hue:213,scale:.92}} onSave={async()=>true}/>)).toContain('Change accent theme');expect(getItem).not.toHaveBeenCalled();
  }finally{vi.unstubAllGlobals();}
});
