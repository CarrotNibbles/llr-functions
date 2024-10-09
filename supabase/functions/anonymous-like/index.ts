import { corsHeaders } from "../_shared/cors.ts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as postgres from "https://deno.land/x/postgres@v0.17.0/mod.ts";

// Get the connection string from the environment variable "SUPABASE_DB_URL"
const databaseUrl = Deno.env.get("SUPABASE_DB_URL");

if (!databaseUrl) {
  throw new Error("SUPABASE_DB_URL environment variable is not set");
}

// Create a database pool with three connections that are lazily established
const pool = new postgres.Pool(databaseUrl, 3, true);

function ips(req: Request) {
  return req.headers.get("x-forwarded-for")?.split(/\s*,\s*/);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Grab a connection from the pool
    const connection = await pool.connect();

    const { strategy: strategyId, token } = await req.json() as {
      strategy: string;
      token: string;
    };
    const clientIps = ips(req) || [""];
    const ip = clientIps[0];

    const formData = new FormData();
    formData.append("secret", Deno.env.get("CLOUDFLARE_SECRET_KEY") ?? "");
    formData.append("response", token);
    formData.append("remoteip", ip);

    const turnstileResponse = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: formData,
      },
    );

    const outcome = await turnstileResponse.json();

    if (!outcome.success) {
      return new Response("Failed to verify captcha", { status: 403 });
    }

    try {
      // Check if the strategy exists
      const [strategyResult, likeResult] = await Promise.all(
        [
          connection
            .queryObject`SELECT 1
                           FROM public.strategies
                          WHERE id=${strategyId}`,
          connection
            .queryObject`SELECT 1
                           FROM public.anon_likes
                          WHERE strategy=${strategyId}
                                AND ip_addr=${ip}
                                AND created_at > NOW() - INTERVAL '1 day'`,
        ],
      );

      // If the strategy does not exist, return a 404
      if ((strategyResult.rowCount ?? 0) === 0) {
        return new Response("Strategy not found", { status: 404 });
      }

      // If the user has already liked the strategy in the last 24 hours, return a 403
      if ((likeResult.rowCount ?? 0) > 0) {
        return new Response(
          "You have already liked this strategy in the last 24 hours",
          { status: 403 },
        );
      }

      // Insert the like into the database
      await connection
        .queryObject`INSERT INTO public.anon_likes (strategy, ip_addr)
                          VALUES (${strategyId}, ${ip})`;

      // Return the response with the correct content type header
      return new Response("Liked!", { status: 200 });
    } finally {
      // Release the connection back into the pool
      connection.release();
    }
  } catch (err) {
    console.error(err);
    return new Response(String(err?.message ?? err), { status: 500 });
  }
});
