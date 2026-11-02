import { AppError } from "./app-error";

// BUG-04: Round.postcodeSectors — the postcode sectors a round covers
// ("CH41", "CH41 2"). Normalised to upper case with single spaces so
// comparisons and de-duplication are stable.

const SECTOR_FORMAT = /^[A-Z]{1,2}\d[A-Z\d]?( \d[A-Z]{0,2})?$/;
const squash = (s: string) => s.replace(/\s+/g, "").toUpperCase();

/** undefined = omitted (untouched); [] = clear. */
export function optPostcodeSectors(v: unknown, field = "postcodeSectors"): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new AppError(400, `"${field}" must be an array of postcode sectors.`);
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") throw new AppError(400, `"${field}" must be an array of postcode sectors.`);
    const sector = raw.trim().replace(/\s+/g, " ").toUpperCase();
    if (!SECTOR_FORMAT.test(sector)) {
      throw new AppError(400, `Invalid postcode sector "${raw}" in ${field}. Expected e.g. "CH41" or "CH41 2".`);
    }
    if (!out.includes(sector)) out.push(sector);
  }
  return out;
}

/** ServiceArea.postcodeSector holds one sector or a comma/semicolon list. */
export function parseAreaSectors(areaPostcodeSector: string | null | undefined): string[] {
  return (areaPostcodeSector ?? "")
    .split(/[,;]/)
    .map((s) => squash(s))
    .filter(Boolean);
}

/** Where the service area records its sector(s), every round sector must sit
 *  inside one ("CH41 2" is inside "CH41"). No area sector data = no check. */
export function assertSectorsInServiceArea(
  sectors: string[],
  area: { name?: string | null; postcodeSector?: string | null } | null | undefined
): void {
  const allowed = parseAreaSectors(area?.postcodeSector);
  if (allowed.length === 0) return;
  const outside = sectors.filter((s) => !allowed.some((a) => squash(s).startsWith(a)));
  if (outside.length > 0) {
    throw new AppError(
      400,
      `Postcode sector(s) ${outside.join(", ")} are outside the service area${area?.name ? ` "${area.name}"` : ""} (${area?.postcodeSector}).`
    );
  }
}
