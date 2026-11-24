import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' }
});

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const secretKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY');
    if (!secretKey) return json({ error: 'Missing server secret key.' }, 500);

    const authorization = request.headers.get('Authorization');
    if (!authorization?.startsWith('Bearer ')) return json({ error: 'Unauthorized.' }, 401);
    const admin = createClient(supabaseUrl, secretKey);
    const accessToken = authorization.slice('Bearer '.length);
    const { data: callerData, error: callerError } = await admin.auth.getUser(accessToken);
    if (callerError || !callerData.user) return json({ error: 'Unauthorized.' }, 401);

    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('role,is_active')
      .eq('id', callerData.user.id)
      .single();
    if (profileError || profile?.role !== 'admin' || !profile.is_active) {
      return json({ error: 'Admin access required.' }, 403);
    }

    const body = await request.json();
    const action = String(body.action || '');
    const productId = String(body.productId || '').trim();

    if (action === 'create') {
      const name = String(body.name || '').trim();
      if (!name) return json({ error: 'Product name is required.' }, 400);
      const { data, error } = await admin.from('products').insert({
        name,
        sale_price: Number(body.salePrice || 0),
        cost_price: Number(body.costPrice || 0),
        is_active: true
      }).select('id,name,sale_price,cost_price,is_active').single();
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, product: data });
    }

    if (!productId) return json({ error: 'productId is required.' }, 400);
    if (action === 'update') {
      const name = String(body.name || '').trim();
      if (!name) return json({ error: 'Product name is required.' }, 400);
      const { data, error } = await admin.from('products').update({
        name,
        sale_price: Number(body.salePrice || 0),
        cost_price: Number(body.costPrice || 0),
        is_active: body.isActive !== false
      }).eq('id', productId).select('id,name,sale_price,cost_price,is_active').single();
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, product: data });
    }

    if (action === 'deactivate') {
      const { error } = await admin.from('products').update({ is_active: false }).eq('id', productId);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : 'Unexpected error.' }, 500);
  }
});
