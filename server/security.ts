import type { Request } from "express";
import { identitySession } from "./identity";
export function isOwner(req: Request) {
  return !!identitySession(req);
}
export function workspaceFor(req: Request) {
  const session=identitySession(req);if(session)return session.userId;
  throw Object.assign(new Error("Sign in with Google to open your private workspace."),{status:401,code:"SIGN_IN_REQUIRED"});
}
export function assertOwner(req: Request) { if (!isOwner(req)) throw Object.assign(new Error("Sign in with Google."),{status:401}); }
