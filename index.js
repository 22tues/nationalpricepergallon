export default {
  // 1. Handlers for Public API Requests (GET /price)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/price") {
      // Pull the cached price from Cloudflare KV
      const cachedData = await env.GAS_STORE.get("national_average", { type: "json" });
      
      if (!cachedData) {
        return new Response(JSON.stringify({ error: "Data warming up. Try again shortly." }), {
          status: 503,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      return new Response(JSON.stringify(cachedData), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    return new Response("Not Found. Hit /price to get the national gas index.", { status: 404 });
  },

  // 2. The Cron Trigger (Runs automatically in the background)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(updateGasPrice(env));
  }
};

// Core function to fetch data and sync it to KV storage
async function updateGasPrice(env) {
  try {
    // EIA public JSON series feed for National Regular Gas Prices
    const targetUrl = "https://eia.gov[]=value&facets[series][]=EMM_EPM0_PTE_NUS_DPG&sort[0][column]=period&sort[0][direction]=desc&length=1";
    
    const response = await fetch(targetUrl, {
      headers: { "User-Agent": "GasWatchdogBot/1.0" }
    });

    if (!response.ok) throw new Error(`EIA API returned status: ${response.status}`);

    const payload = await response.json();
    const latestRecord = payload?.response?.data?.[0];

    if (!latestRecord || !latestRecord.value) {
      throw new Error("Invalid or empty data payload from EIA");
    }

    const priceData = {
      national_average_usd: parseFloat(latestRecord.value),
      as_of_date: latestRecord.period, // Format: YYYY-MM-DD
      last_updated_by_bot: new Date().toISOString()
    };

    // Save permanently to Cloudflare KV Namespace
    await env.GAS_STORE.put("national_average", JSON.stringify(priceData));
    console.log("Successfully updated gas index:", priceData.national_average_usd);

    // OPTIONAL: Broadcast to Discord if you have a Webhook set up
    if (env.DISCORD_WEBHOOK_URL) {
      await fetch(env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `⛽ **Gas Price Update:** The current US National Gasoline Index is **$${priceData.national_average_usd.toFixed(2)}** per gallon (As of: ${priceData.as_of_date}).`
        })
      });
    }

  } catch (error) {
    console.error("Worker failed to fetch or sync gas data:", error.message);
  }
}
