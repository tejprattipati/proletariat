import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";
function equal(a: string, b: string) { const left=Buffer.from(a), right=Buffer.from(b); return left.length === right.length && timingSafeEqual(left,right); }
export function isOwner(req: Request) {
  const expected=process.env.APP_ACCESS_TOKEN;
  const supplied=req.get("authorization")?.replace(/^Bearer /,"") || "";
  if (expected) return equal(supplied,expected);
  if (process.env.NODE_ENV === "production") return false;
  const remote=req.socket.remoteAddress || "";
  const origin=req.get("origin");
  const localOrigin=!origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const localHost=/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.get("host") || "");
  return localHost && localOrigin && ["127.0.0.1","::1","::ffff:127.0.0.1"].includes(remote);
}
export function workspaceFor(req: Request) {
  if (isOwner(req)) return "owner";
  const value=req.get("x-workspace-id") || "";
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw new Error("A browser workspace ID is required.");
  return `demo:${value}`;
}
export function assertOwner(req: Request) { if (!isOwner(req)) throw new Error("Owner access is required for live connections. Set your owner access key in Settings."); }
