import type { BigIntStats } from "node:fs";
import { z } from "zod";

/**
 * Filesystem metadata recorded when a file was read. Used ONLY to notice that something
 * probably changed since the last scan. Equal metadata does not prove equal content:
 * evidence and apply guards always use byte hashes, never this.
 */
export const FileMetaSchema = z.object({
  dev: z.string(),
  ino: z.string(),
  size: z.string(),
  mtimeNs: z.string(),
  ctimeNs: z.string(),
  nlink: z.string(),
});
export type FileMeta = z.infer<typeof FileMetaSchema>;

export const fileMetaFrom = (st: BigIntStats): FileMeta => ({
  dev: st.dev.toString(),
  ino: st.ino.toString(),
  size: st.size.toString(),
  mtimeNs: st.mtimeNs.toString(),
  ctimeNs: st.ctimeNs.toString(),
  nlink: st.nlink.toString(),
});

export const DirIdentitySchema = z.object({ dev: z.string(), ino: z.string() });
export type DirIdentity = z.infer<typeof DirIdentitySchema>;
