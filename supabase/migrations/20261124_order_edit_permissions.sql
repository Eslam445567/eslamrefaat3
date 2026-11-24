-- تعديل الأوردر بالكامل وصلاحيات المسوقين بشكل منفصل.

alter table public.profiles
  add column if not exists permissions jsonb not null default '{}'::jsonb;

-- التعديل الكامل للأوردرات متاح افتراضيًا للمسوق، بينما باقي الصلاحيات اختيارية.
update public.profiles
set permissions = jsonb_build_object(
  'view_all_orders', coalesce((permissions->>'view_all_orders')::boolean, false),
  'edit_orders', coalesce((permissions->>'edit_orders')::boolean, true),
  'delete_orders', coalesce((permissions->>'delete_orders')::boolean, false),
  'print_picking', coalesce((permissions->>'print_picking')::boolean, false),
  'add_product', coalesce((permissions->>'add_product')::boolean, false),
  'edit_product', coalesce((permissions->>'edit_product')::boolean, false),
  'delete_product', coalesce((permissions->>'delete_product')::boolean, false)
)
where role = 'marketer';

create or replace function public.admin_manage_marketer_permissions(
  p_user_id uuid,
  p_permissions jsonb default '{}'::jsonb
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

  update public.profiles
  set permissions = jsonb_build_object(
    'view_all_orders', coalesce((p_permissions->>'view_all_orders')::boolean, false),
    'edit_orders', coalesce((p_permissions->>'edit_orders')::boolean, true),
    'delete_orders', coalesce((p_permissions->>'delete_orders')::boolean, false),
    'print_picking', coalesce((p_permissions->>'print_picking')::boolean, false),
    'add_product', coalesce((p_permissions->>'add_product')::boolean, false),
    'edit_product', coalesce((p_permissions->>'edit_product')::boolean, false),
    'delete_product', coalesce((p_permissions->>'delete_product')::boolean, false)
  )
  where id = p_user_id and role = 'marketer'
  returning to_jsonb(profiles.*) into result;

  if result is null then raise exception 'Marketer not found'; end if;
  return result;
end;
$$;

grant execute on function public.admin_manage_marketer_permissions(uuid, jsonb) to authenticated;

-- يعرض للمسوق المصرح له كل الأوردرات بدون التكلفة أو الربح.
create or replace function public.get_orders_for_marketer_all()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      (
        to_jsonb(o)
        || jsonb_build_object(
          'product_name', p.name,
          'marketer_name', m.name,
          'order_group_id', o.order_group_id,
          'order_item_no', coalesce(o.order_item_no, 1)
        )
      ) - 'cost_price' - 'total_profit' - 'profit'
      order by o.created_at desc
    ),
    '[]'::jsonb
  )
  from public.orders o
  left join public.products p on p.id = o.product_id
  left join public.profiles m on m.id = o.marketer_id
  where exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'marketer'
      and p.is_active is true
      and lower(coalesce(p.permissions->>'view_all_orders', 'false')) = 'true'
  );
$$;

grant execute on function public.get_orders_for_marketer_all() to authenticated;

-- يسمح للمسوق بتعديل أوردراته، أو كل الأوردرات إذا مُنح الصلاحيتين.
create or replace function public.update_order_with_items(
  p_order_id uuid,
  p_client_name text,
  p_client_phone text,
  p_client_address text,
  p_items jsonb,
  p_notes text default '',
  p_status text default 'pending',
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
  caller_permissions jsonb;
  root_marketer_id uuid;
  root_group_id uuid;
  group_id uuid;
  existing_ids uuid[];
  item jsonb;
  created_order_json jsonb;
  item_product_id uuid;
  item_quantity integer;
  item_sale_price numeric;
  created_order_id uuid;
  item_count integer;
  existing_count integer;
  idx integer;
begin
  select role, is_active, permissions
    into caller_role, caller_active, caller_permissions
  from public.profiles where id = auth.uid();
  if caller_role is null or caller_active is not true then
    raise exception 'Active profile required';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one order item is required';
  end if;

  select o.marketer_id, o.order_group_id
    into root_marketer_id, root_group_id
  from public.orders o where o.id = p_order_id;
  if not found then raise exception 'Order not found'; end if;

  if caller_role <> 'admin' and not (
    coalesce((caller_permissions->>'edit_orders')::boolean, true)
    and (
      root_marketer_id = auth.uid()
      or coalesce((caller_permissions->>'view_all_orders')::boolean, false)
    )
  ) then
    raise exception 'You do not have permission to edit this order';
  end if;

  group_id := coalesce(root_group_id, p_order_id);
  existing_ids := array(
    select o.id
    from public.orders o
    where (root_group_id is not null and o.order_group_id = root_group_id)
       or (root_group_id is null and o.id = p_order_id)
    order by coalesce(o.order_item_no, 1), o.created_at, o.id
  );
  existing_count := coalesce(array_length(existing_ids, 1), 0);
  item_count := jsonb_array_length(p_items);

  -- تحويل الأوردر القديم ذي السطر الواحد إلى مجموعة عند إضافة أصناف جديدة.
  if root_group_id is null and item_count > 1 then
    update public.orders set order_group_id = group_id, order_item_no = 1 where id = p_order_id;
  end if;

  for idx in 1..least(existing_count, item_count) loop
    select value into item
    from jsonb_array_elements(p_items) with ordinality as items(value, ordinality)
    where items.ordinality = idx;
    item_product_id := nullif(item->>'productId', '')::uuid;
    item_quantity := greatest(1, coalesce(nullif(item->>'quantity', '')::integer, 1));
    item_sale_price := nullif(item->>'salePrice', '')::numeric;
    if item_product_id is null or item_sale_price is null then
      raise exception 'Every item needs a product and sale price';
    end if;

    perform public.update_order(
      existing_ids[idx],
      trim(coalesce(p_client_name, '')),
      trim(coalesce(p_client_phone, '')),
      trim(coalesce(p_client_address, '')),
      coalesce(p_notes, ''),
      p_status::order_status,
      item_product_id,
      item_quantity,
      item_sale_price,
      null::numeric
    );
    update public.orders
    set order_group_id = group_id, order_item_no = idx
    where id = existing_ids[idx];
  end loop;

  if existing_count > item_count then
    for idx in (item_count + 1)..existing_count loop
      delete from public.orders where id = existing_ids[idx];
    end loop;
  elsif item_count > existing_count then
    for idx in (existing_count + 1)..item_count loop
      select value into item
      from jsonb_array_elements(p_items) with ordinality as items(value, ordinality)
      where items.ordinality = idx;
      item_product_id := nullif(item->>'productId', '')::uuid;
      item_quantity := greatest(1, coalesce(nullif(item->>'quantity', '')::integer, 1));
      item_sale_price := nullif(item->>'salePrice', '')::numeric;
      if item_product_id is null or item_sale_price is null then
        raise exception 'Every item needs a product and sale price';
      end if;

      select to_jsonb(created_order_row) into created_order_json
      from public.create_order(
        trim(coalesce(p_client_name, '')),
        trim(coalesce(p_client_phone, '')),
        trim(coalesce(p_client_address, '')),
        item_product_id,
        item_quantity,
        coalesce(p_notes, ''),
        case when caller_role = 'admin' then root_marketer_id else null end,
        item_sale_price
      ) as created_order_row;
      created_order_id := coalesce(
        nullif(created_order_json->>'id', '')::uuid,
        nullif(created_order_json->'create_order'->>'id', '')::uuid
      );
      if created_order_id is null then raise exception 'Could not create order item'; end if;
      if p_status is not null and p_status <> 'pending' then
        perform public.update_order(
          created_order_id,
          trim(coalesce(p_client_name, '')),
          trim(coalesce(p_client_phone, '')),
          trim(coalesce(p_client_address, '')),
          coalesce(p_notes, ''),
          p_status::order_status,
          item_product_id,
          item_quantity,
          item_sale_price,
          null::numeric
        );
      end if;
      update public.orders
      set order_group_id = group_id, order_item_no = idx
      where id = created_order_id;
    end loop;
  end if;

  if caller_role = 'admin' then
    update public.orders set marketer_id = p_marketer_id
    where (order_group_id = group_id) or (order_group_id is null and id = p_order_id);
  end if;

  return group_id;
end;
$$;

grant execute on function public.update_order_with_items(uuid, text, text, text, jsonb, text, text, uuid) to authenticated;

create or replace function public.delete_order_group(p_order_group_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role text;
  caller_active boolean;
  caller_permissions jsonb;
begin
  select role, is_active, permissions into caller_role, caller_active, caller_permissions
  from public.profiles where id = auth.uid();
  if caller_role is null or caller_active is not true then raise exception 'Active profile required'; end if;
  if caller_role = 'marketer' and not coalesce((caller_permissions->>'delete_orders')::boolean, false) then
    raise exception 'Delete order permission required';
  end if;
  if caller_role <> 'admin' and not exists (
    select 1 from public.orders o
    where (o.order_group_id = p_order_group_id or o.id = p_order_group_id)
      and o.marketer_id = auth.uid()
  ) and not coalesce((caller_permissions->>'view_all_orders')::boolean, false) then
    raise exception 'You can only delete allowed orders';
  end if;
  delete from public.orders
  where order_group_id = p_order_group_id or id = p_order_group_id;
  return true;
end;
$$;

grant execute on function public.delete_order_group(uuid) to authenticated;

-- السماح بإدارة المنتجات للمسوق حسب الصلاحية الممنوحة له.
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
  caller_permissions jsonb;
  result jsonb;
  allowed boolean := false;
begin
  select role, is_active, permissions into caller_role, caller_active, caller_permissions
  from public.profiles where id = auth.uid();
  if caller_active is not true or caller_role is null then raise exception 'Active profile required'; end if;
  if caller_role = 'admin' then
    allowed := true;
  elsif caller_role = 'marketer' then
    allowed := case p_action
      when 'create' then coalesce((caller_permissions->>'add_product')::boolean, false)
      when 'update' then coalesce((caller_permissions->>'edit_product')::boolean, false)
      when 'deactivate' then coalesce((caller_permissions->>'delete_product')::boolean, false)
      else false
    end;
  end if;
  if not allowed then raise exception 'Product permission required'; end if;

  if p_action = 'create' then
    insert into public.products(name, sale_price, cost_price, is_active)
    values (trim(coalesce(p_name, '')), coalesce(p_sale_price, 0), case when caller_role = 'admin' then coalesce(p_cost_price, 0) else 0 end, true)
    returning to_jsonb(products.*) into result;
  elsif p_action = 'update' then
    update public.products
    set name = trim(coalesce(p_name, name)),
        sale_price = coalesce(p_sale_price, sale_price),
        cost_price = case when caller_role = 'admin' then coalesce(p_cost_price, cost_price) else cost_price end,
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
