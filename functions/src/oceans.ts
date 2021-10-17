import axios from "axios";

export const OCEAN_API = "https://autoshark.finance/.netlify/functions/oceans";

export interface Ocean {
  name: string;
  depositToken: string;
  earningToken: string;
  address: string;
  depositTokenAddress: string;
  earningTokenAddress: string;
  active: boolean;
}

export async function getOceans(): Promise<Ocean[]> {
  let res = await axios.get(OCEAN_API);
  const oceans: Ocean[] = (res.data as any).data;
  return oceans;
}
