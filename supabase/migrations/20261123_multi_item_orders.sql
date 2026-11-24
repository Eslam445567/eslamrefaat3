-- يدعم هذا التحديث أكثر من صنف داخل رقم أوردر واحد، مع الحفاظ على الأوردرات القديمة.

alter table public.orders
  add column if not exists order_group_id uuid,
  add column if not exists order_item_no integer;

create index if not exists orders_order_group_id_idx on public.orders(order_group_id);

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
  item_product_id uuid;
  item_quantity integer;
  item_sale_price numeric;
  created_order_json jsonb;
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

    -- نستفيد من قواعد التحقق والتسعير الموجودة في create_order ثم نربط السطر بالمجموعة.
    -- create_order ترجع قيمة JSON في قاعدة البيانات الحالية، وليس صفًا
    -- يمكن اختيار العمود id منه مباشرة. نُحوّل النتيجة إلى JSON ونستخرج
    -- المعرف، مع دعم النتيجة الصفية أيضًا إن كانت الدالة قديمة.
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

create or replace function public.delete_order_group(p_order_group_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role text;
  caller_active boolean;
begin
  select role, is_active into caller_role, caller_active
  from public.profiles where id = auth.uid();
  if caller_role is null or caller_active is not true then
    raise exception 'Active profile required';
  end if;
  if caller_role <> 'admin' and not exists (
    select 1 from public.orders
    where order_group_id = p_order_group_id and marketer_id = auth.uid()
  ) then
    raise exception 'You can only delete your own order';
  end if;
  delete from public.orders where order_group_id = p_order_group_id;
  return true;
end;
$$;

grant execute on function public.create_order_with_items(text, text, text, jsonb, text, uuid) to authenticated;
grant execute on function public.delete_order_group(uuid) to authenticated;

create or replace function public.admin_manage_product(
  p_action text,
  p_product_id uuid default null,
  p_name text default null,
  p_sale_price numeric default 0,
  p_cost_price numeric default 0,
  p_is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role text;
  caller_active boolean;
  result jsonb;
begin
  select role, is_active into caller_role, caller_active
  from public.profiles where id = auth.uid();
  if caller_role <> 'admin' or caller_active is not true then
    raise exception 'Admin access required';
  end if;

  if p_action = 'create' then
    insert into public.products(name, sale_price, cost_price, is_active)
    values (trim(coalesce(p_name, '')), coalesce(p_sale_price, 0), coalesce(p_cost_price, 0), true)
    returning to_jsonb(products.*) into result;
  elsif p_action = 'update' then
    update public.products
    set name = trim(coalesce(p_name, name)),
        sale_price = coalesce(p_sale_price, sale_price),
        cost_price = coalesce(p_cost_price, cost_price),
        is_active = coalesce(p_is_active, is_active)
    where id = p_product_id
    returning to_jsonb(products.*) into result;
  elsif p_action = 'deactivate' then
    update public.products set is_active = false where id = p_product_id
    returning to_jsonb(products.*) into result;
  else
    raise exception 'Unknown product action';
  end if;
  if result is null then raise exception 'Product not found'; end if;
  return result;
end;
$$;

grant execute on function public.admin_manage_product(text, uuid, text, numeric, numeric, boolean) to authenticated;

-- الـ Views الجديدة تضيف بيانات المجموعة دون تغيير أسماء الأعمدة التي تستخدمها الواجهة الحالية.
drop view if exists public.orders_for_admin_items;
create view public.orders_for_admin_items as
select base.*, orders.order_group_id, coalesce(orders.order_item_no, 1) as order_item_no
from public.orders_for_admin base
join public.orders on public.orders.id = base.id;

drop view if exists public.orders_for_marketers_items;
create view public.orders_for_marketers_items as
select base.*, orders.order_group_id, coalesce(orders.order_item_no, 1) as order_item_no
from public.orders_for_marketers base
join public.orders on public.orders.id = base.id;

grant select on public.orders_for_admin_items to authenticated;
grant select on public.orders_for_marketers_items to authenticated;
