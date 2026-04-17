const waitUntil = route.slug === "tourism" ? "domcontentloaded" : "networkidle";
await page.goto(url, { waitUntil, timeout: 30_000 });