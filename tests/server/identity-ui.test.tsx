import { expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { IdentityGate } from '../../src/components/IdentityGate';
it('does not render or execute private workspace children before sign-in',()=>{
  let rendered=false;
  function PrivateWorkspace(){rendered=true;return <p>Private source content</p>;}
  const html=renderToString(<IdentityGate><PrivateWorkspace/></IdentityGate>);
  expect(rendered).toBe(false);expect(html).not.toContain('Private source content');expect(html).toContain('Continue with Google');
});
