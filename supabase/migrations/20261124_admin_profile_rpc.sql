-- يسمح لـ Edge Function بالتحقق من صلاحية المستخدم الحالي
-- بدون فتح جدول profiles للقراءة العامة أو تعطيل RLS.

create or replace function public.get_my_admin_profile()
returns table(role text, is_active boolean)
language sql
security definer
set search_path = public
as $$
  select p.role, p.is_active
  from public.profiles as p
  where p.id = auth.uid()
  limit 1;
$$;

revoke all on function public.get_my_admin_profile() from public;
grant execute on function public.get_my_admin_profile() to authenticated;
