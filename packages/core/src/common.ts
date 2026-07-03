export type JsonSchema = object;
export type SerializedState = unknown;
export interface Cost {
    usd?: number;
    tokensIn?: number;
    tokensOut?: number;
    model?: string;
}
/** Runtime-Marker, damit das Paket eine Wert-Oberfläche zum Importieren/Testen hat. */
export const ELIO_CORE_VERSION = "0.0.0";
