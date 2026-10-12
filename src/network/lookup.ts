import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
/** Pin every happy-eyeballs candidate to the addresses approved before dialing. */
export function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
  return ((
    _hostname: string,
    options: { all?: boolean; family?: number },
    callback: (
      error: Error | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    const choices =
      options.family === 4 || options.family === 6
        ? addresses.filter((entry) => entry.family === options.family)
        : addresses;
    if (!choices.length) {
      callback(new Error("No approved address for requested family"), []);
      return;
    }
    if (options.all)
      callback(
        null,
        choices.map((entry) => ({ ...entry })),
      );
    else callback(null, choices[0]!.address, choices[0]!.family);
  }) as LookupFunction;
}
