-- إصلاح حفظ الأوردر متعدد الأصناف بعد تطبيق ترحيل 20261123.
-- سبب الخطأ: create_order ترجع JSON، لذلك لا يمكن تنفيذ select id منها مباشرة.

create or replace function public.create_order_with_items(
  p_client_name text,
  p_client_phone text,
  p_client_address text,
  p_items jsonb,
  p_notes text default '',
  p_marketer_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role text;
  caller_active boolean;
  order_group uuid := gen_random_uuid();
  item jsonb;
  item_no integer;
  created_order_id uuid;
  created_order_json jsonb;
  item_product_id uuid;
  item_quantity integer;
  item_sale_price numeric;
begin
  select role, is_active into caller_role, caller_active
  from public.profiles where id = auth.uid();
  if caller_role is null or caller_active is not true then
    raise exception 'Active profile required';
  end if;
  if caller_role not in ('admin', 'marketer') then
    raise exception 'Insufficient permissions';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one order item is required';
  end if;
  if caller_role = 'marketer' and p_marketer_id is not null then
    raise exception 'Marketers cannot assign another marketer';
  end if;

  for item, item_no in
    select value, ordinality::integer
    from jsonb_array_elements(p_items) with ordinality
  loop
    item_product_id := nullif(item->>'productId', '')::uuid;
    item_quantity := greatest(1, coalesce(nullif(item->>'quantity', '')::integer, 1));
    item_sale_price := nullif(item->>'salePrice', '')::numeric;
    if item_product_id is null then raise exception 'Every item needs a product'; end if;

    select to_jsonb(created_order_row)
      into created_order_json
    from public.create_order(
      p_client_name,
      p_client_phone,
      p_client_address,
      item_product_id,
      item_quantity,
      coalesce(p_notes, ''),
      case when caller_role = 'admin' then p_marketer_id else null end,
      case when caller_role = 'admin' then item_sale_price else null end
    ) as created_order_row;
    created_order_id := coalesce(
      nullif(created_order_json->>'id', '')::uuid,
      nullif(created_order_json->'create_order'->>'id', '')::uuid
    );
    if created_order_id is null then
      raise exception 'create_order did not return a valid order id';
    end if;

    update public.orders
    set order_group_id = order_group, order_item_no = item_no
    where id = created_order_id;
  end loop;

  return order_group;
end;
$$;

grant execute on function public.create_order_with_items(text, text, text, jsonb, text, uuid) to authenticated;
