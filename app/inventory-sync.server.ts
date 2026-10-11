import {
  findDestinationVariantByBarcode,
  getDestination,
  setDestinationAvailableQuantity,
  type DestinationName,
} from "./stores.server";

const DESTINATIONS: DestinationName[] = ["belwari", "keno"];

export async function syncInventoryToDestinations(params: {
  barcode?: string | null;
  quantity: number;
}): Promise<void> {
  const { barcode, quantity } = params;

  if (!barcode?.trim()) {
    console.warn(
      "[inventory] source item has no barcode; skipping (barcode is the match key)",
    );
    return;
  }

  const failures: string[] = [];

  for (const name of DESTINATIONS) {
    const destination = getDestination(name);
    if (!destination) {
      console.warn(`[inventory] destination "${name}" is not configured; skipping`);
      continue;
    }

    try {
      const variant = await findDestinationVariantByBarcode(destination, barcode);

      if (!variant) {
        console.warn(
          `[inventory] no ${name} variant matched barcode="${barcode}"; skipping (never creates)`,
        );
        continue;
      }

      await setDestinationAvailableQuantity(
        destination,
        variant.inventoryItemId,
        quantity,
      );
      console.log(`[inventory] set ${name} available=${quantity} (barcode="${barcode}")`);
    } catch (error) {
      failures.push(`${name}: ${String(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`inventory sync failed for ${failures.join("; ")}`);
  }
}
