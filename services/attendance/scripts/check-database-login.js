// Live integration check. No personal data or connection strings are printed.
// All row changes roll back; identity sequences may advance during the check.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env'), quiet: true });
const assert = require('node:assert/strict');
const pool = require('../db/pool');

async function main() {
  const client = await pool.connect();
  let checks = 0;
  async function denied(sql) {
    await client.query('SAVEPOINT denied_operation');
    let code;
    try { await client.query(sql); } catch (error) { code = error.code; }
    await client.query('ROLLBACK TO SAVEPOINT denied_operation');
    await client.query('RELEASE SAVEPOINT denied_operation');
    assert.equal(code, '42501', 'An out-of-scope operation was not denied');
    checks++;
  }
  try {
    await client.query('BEGIN');
    const identity = (await client.query(`SELECT current_user AS name, r.rolsuper,
      r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
      (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) AS memberships,
      (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls
      FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
    assert.equal(identity.name, 'hader_attendance');
    for (const flag of ['rolsuper','rolcreaterole','rolcreatedb','rolreplication','rolbypassrls']) assert.equal(identity[flag],false);
    assert.equal(identity.memberships,0);
    assert.equal(identity.tls,true);
    checks++;

    // Existing fixtures are read only; no registration/profile/workshop is created.
    const fixture = (await client.query(`SELECT w.workshop_id, w.organizer_id,
      r.registration_id, r.attendee_id FROM public.workshops w
      JOIN public.registrations r ON r.workshop_id=w.workshop_id
      JOIN public.profiles p ON p.id=w.organizer_id
      ORDER BY w.workshop_id, r.registration_id LIMIT 1 FOR UPDATE OF w`)).rows[0];
    assert.ok(fixture,'A workshop with an organizer profile and registration is required');
    checks++;
    await client.query('SELECT id, name, role FROM public.profiles WHERE id=$1',[fixture.organizer_id]);
    await client.query('SELECT workshop_id, title, workshop_date, organizer_id FROM public.workshops WHERE workshop_id=$1',[fixture.workshop_id]);
    const session = (await client.query(`INSERT INTO public.sessions
      (workshop_id,title,start_time,end_time) VALUES ($1,'Dedicated login rollback check',
      '2099-01-01T10:00:00Z','2099-01-01T11:00:00Z')
      RETURNING session_id,workshop_id,title,start_time,end_time,checkin_status,created_at`,[fixture.workshop_id])).rows[0];
    await client.query(`SELECT s.session_id,s.checkin_status,w.organizer_id FROM public.sessions s
      JOIN public.workshops w ON w.workshop_id=s.workshop_id
      WHERE s.session_id=$1 AND w.workshop_id=$2 FOR UPDATE OF s`,[session.session_id,fixture.workshop_id]);
    await client.query(`UPDATE public.sessions SET checkin_status='open'
      WHERE session_id=$1 RETURNING session_id,workshop_id,checkin_status`,[session.session_id]);
    const insert = `INSERT INTO public.attendance (session_id,registration_id,checked_in_by)
      VALUES ($1,$2,$3) ON CONFLICT (session_id,registration_id) DO NOTHING
      RETURNING attendance_id,session_id,registration_id,checked_in_at`;
    const params = [session.session_id,fixture.registration_id,fixture.organizer_id];
    assert.equal((await client.query(insert,params)).rowCount,1);
    assert.equal((await client.query(insert,params)).rowCount,0);
    checks+=5;

    await client.query(`SELECT r.registration_id,r.attendee_id,p.name AS attendee_name,
      COUNT(DISTINCT s.session_id)::int AS attended_sessions FROM public.registrations r
      JOIN public.profiles p ON p.id=r.attendee_id
      LEFT JOIN public.attendance a ON a.registration_id=r.registration_id
      LEFT JOIN public.sessions s ON s.session_id=a.session_id AND s.workshop_id=r.workshop_id
      WHERE r.workshop_id=$1 GROUP BY r.registration_id,r.attendee_id,p.name
      ORDER BY p.name,r.registration_id`,[fixture.workshop_id]);
    await client.query(`SELECT
      (SELECT COUNT(*)::int FROM public.sessions WHERE workshop_id=$1) AS total_sessions,
      (SELECT COUNT(DISTINCT s.session_id)::int FROM public.sessions s
       JOIN public.attendance a ON a.session_id=s.session_id
       WHERE s.workshop_id=$1 AND a.registration_id=r.registration_id) AS attended_sessions
      FROM public.registrations r WHERE r.workshop_id=$1 AND r.attendee_id=$2 LIMIT 1`,
    [fixture.workshop_id,fixture.attendee_id]);
    checks+=2;

    for (const sql of [
      'SELECT * FROM auth.users LIMIT 1',
      'SELECT * FROM public.certificates LIMIT 1',
      'SELECT * FROM public.notifications LIMIT 1',
      'SELECT * FROM public.waitlist LIMIT 1',
      'SELECT * FROM public.rate_limits LIMIT 1',
      "UPDATE public.workshops SET title=title WHERE false",
      `UPDATE public.workshops SET workshop_id=workshop_id WHERE workshop_id=${Number(fixture.workshop_id)}`,
      'INSERT INTO public.registrations (workshop_id,attendee_id) SELECT workshop_id,attendee_id FROM public.registrations WHERE false',
      'UPDATE public.profiles SET role=role WHERE false',
      'DELETE FROM public.sessions WHERE false',
      'UPDATE public.sessions SET title=title WHERE false',
      'UPDATE public.attendance SET checked_in_at=checked_in_at WHERE false',
      'DELETE FROM public.attendance WHERE false',
      'ALTER TABLE public.sessions ADD COLUMN login_test_forbidden integer',
      'CREATE TABLE public.login_test_forbidden (id integer)',
      "SELECT nextval('public.sessions_session_id_seq')"
    ]) await denied(sql);
    console.log(JSON.stringify({result:'passed',checks,login:'hader_attendance',tls:true,rowChanges:'rolled back'}));
  } finally {
    await client.query('ROLLBACK').catch(()=>{});
    client.release();
  }
}
main().catch(error=>{
  // Error messages can contain server data; report only a code.
  const reason = /tenant or user not found/i.test(error.message) ? 'POOLER_TENANT_NOT_FOUND'
    : /password authentication failed/i.test(error.message) ? 'AUTHENTICATION_FAILED'
    : error.code === 'ERR_ASSERTION' ? 'ASSERTION_FAILED' : 'CONNECTION_OR_PERMISSION_CHECK';
  console.error(JSON.stringify({result:'failed',code:error.code || 'CHECK_FAILED',reason}));
  process.exitCode=1;
}).finally(()=>pool.end());
