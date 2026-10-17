import {
  findDestinationVariantByBarcode,
  getDestination,
  setDestinationAvailableQuantity,
  type DestinationConfig,
  type DestinationName,
} from "./stores.server";
import { log, logError, logWarn } from "./logger.server";

const DESTINATIONS: DestinationName[] = ["belwari", "keno"];

interface InventorySyncParams {
  barcode?: string | null;
  quantity: number;
}

interface DestinationInventoryParams {
  barcode: string;
  quantity: number;
}

export async function syncInventoryToDestinations(
  params: InventorySyncParams,
): Promise<void> {
  const barcode = params.barcode?.trim();

  if (!barcode) {
    logWarn("inventory", "source item has no barcode; skipping", {
      reason: "barcode is the match key",
    });
    return;
  }

  log("inventory", "syncing quantity", { barcode, quantity: params.quantity });

  const failures: string[] = [];

  for (const name of DESTINATIONS) {
    const destination = getDestination(name);

    if (!destination) {
      logWarn("inventory", "destination not configured; skipping", {
        destination: name,
      });
      continue;
    }

    try {
      await syncToDestination(destination, { barcode, quantity: params.quantity });
    } catch (error) {
      logError("inventory", "destination sync failed", {
        destination: name,
        barcode,
        error: String(error),
      });
      failures.push(`${name}: ${String(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`inventory sync failed for ${failures.join("; ")}`);
  }
}

async function syncToDestination(
  destination: DestinationConfig,
  params: DestinationInventoryParams,
): Promise<void> {
  const { barcode, quantity } = params;

  const variant = await findDestinationVariantByBarcode(destination, barcode);

  if (!variant) {
    logWarn("inventory", "no variant matched barcode; skipping (never creates)", {
      destination: destination.name,
      barcode,
    });
    return;
  }

  await setDestinationAvailableQuantity(
    destination,
    variant.inventoryItemId,
    quantity,
  );

  log("inventory", "set available quantity", {
    destination: destination.name,
    barcode,
    quantity,
  });
}
