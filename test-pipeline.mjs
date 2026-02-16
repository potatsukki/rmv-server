/**
 * End-to-end pipeline test for the RMV System
 * Tests the full flow: Customer → Agent → Sales Staff → Engineer → Customer → Cashier → Fabricator
 */

const BASE = 'http://localhost:5000/api/v1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Helpers ──
async function request(method, path, body, cookies = {}) {
  const headers = { 'Content-Type': 'application/json' };
  
  // Build cookie string
  const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookieStr) headers['Cookie'] = cookieStr;
  
  // Add CSRF header
  if (cookies.csrfToken) headers['X-CSRF-Token'] = cookies.csrfToken;
  
  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url, opts);
  
  // Parse set-cookie headers
  const setCookies = {};
  const rawCookies = res.headers.getSetCookie?.() || [];
  for (const c of rawCookies) {
    const [pair] = c.split(';');
    const [name, ...vals] = pair.split('=');
    setCookies[name.trim()] = vals.join('=').trim();
  }
  
  let data = null;
  try { data = await res.json(); } catch {}
  
  return { status: res.status, data, cookies: setCookies };
}

async function createSession() {
  const res = await request('GET', '/csrf-token');
  return { ...res.cookies };
}

async function login(email, password, _depth = 0) {
  if (_depth > 2) throw new Error(`Login recursion limit for ${email}`);
  
  const cookies = await createSession();
  const res = await request('POST', '/auth/login', { email, password }, cookies);
  
  // Handle rate limiting — wait and retry
  if (res.status === 429) {
    info(`Rate limited on login for ${email}, waiting 62s...`);
    await sleep(62000);
    return login(email, password, _depth); // Retry same depth after waiting
  }
  
  if (res.status !== 200) {
    // If login fails with wrong creds and we haven't tried the ! suffix, try it
    if (_depth === 0 && (res.data?.error?.code === 'INVALID_CREDENTIALS' || res.data?.error?.code === 'UNAUTHORIZED')) {
      return login(email, password + '!', _depth + 1);
    }
    // Rate limited or other error — just return the failure
    return { cookies, data: res.data, status: res.status };
  }
  
  // Merge cookies from login response
  Object.assign(cookies, res.cookies);
  if (res.data?.data?.csrfToken) {
    cookies.csrfToken = res.data.data.csrfToken;
  }
  
  // Handle mustChangePassword
  if (res.data?.data?.user?.mustChangePassword) {
    const newPw = password + '!';
    const changePwRes = await request('POST', '/auth/change-password', {
      currentPassword: password,
      newPassword: newPw,
    }, cookies);
    
    if (changePwRes.status === 200) {
      info(`Password changed for ${email}`);
      return login(email, newPw, _depth + 1);
    }
  }
  
  return { cookies, data: res.data, status: res.status };
}

function log(icon, msg) { console.log(`${icon} ${msg}`); }
function pass(msg) { log('✅', msg); }
function fail(msg, detail) { log('❌', `${msg}: ${JSON.stringify(detail)}`); }
function info(msg) { log('ℹ️', msg); }
function section(msg) { console.log(`\n${'═'.repeat(60)}\n  ${msg}\n${'═'.repeat(60)}`); }

// ── Main Test ──
async function main() {
  let errors = [];
  
  // ━━━━━━━━━━━━ STEP 0: SETUP TEST USERS ━━━━━━━━━━━━
  section('STEP 0: Setup — Login as Admin & Create Test Users');
  
  const admin = await login('admin@rmvsteelfab.com', 'Admin@12345');
  if (admin.status !== 200) {
    fail('Admin login failed', admin.data);
    return;
  }
  pass('Admin logged in');
  
  // Create test users (ignore if already exist)
  const testUsers = [
    { email: 'customer-test@example.com', password: 'Test@12345', firstName: 'Test', lastName: 'Customer', roles: ['customer'] },
    { email: 'agent-test@example.com', password: 'Test@12345', firstName: 'Test', lastName: 'Agent', roles: ['appointment_agent'] },
    { email: 'sales-test@example.com', password: 'Test@12345', firstName: 'Test', lastName: 'Sales', roles: ['sales_staff'] },
    { email: 'engineer-test@example.com', password: 'Test@12345', firstName: 'Test', lastName: 'Engineer', roles: ['engineer'] },
    { email: 'cashier-test@example.com', password: 'Test@12345', firstName: 'Test', lastName: 'Cashier', roles: ['cashier'] },
    { email: 'fabricator-test@example.com', password: 'Test@12345', firstName: 'Test', lastName: 'Fabricator', roles: ['fabrication_staff'] },
  ];
  
  const userIds = {};
  for (const u of testUsers) {
    const res = await request('POST', '/users/admin/users', u, admin.cookies);
    if (res.status === 201 || res.status === 200) {
      userIds[u.roles[0]] = res.data.data._id;
      pass(`Created ${u.roles[0]}: ${u.email}`);
    } else if (res.data?.error?.code === 'CONFLICT' || res.status === 409) {
      info(`${u.roles[0]} already exists, fetching ID...`);
      // Get user list to find ID
      const listRes = await request('GET', `/users/admin/users?role=${u.roles[0]}`, null, admin.cookies);
      const users = listRes.data?.data;
      if (Array.isArray(users) && users.length) {
        userIds[u.roles[0]] = users[0]._id;
        pass(`Found existing ${u.roles[0]}: ${userIds[u.roles[0]]}`);
      } else {
        fail(`Could not fetch ${u.roles[0]} user ID`, listRes.data);
      }
    } else {
      fail(`Failed to create ${u.roles[0]}`, res.data);
      errors.push(`create_${u.roles[0]}`);
    }
  }
  
  // ━━━━━━━━━━━━ STEP 1: CUSTOMER BOOKS APPOINTMENT ━━━━━━━━━━━━
  section('STEP 1: Customer Books an Appointment');
  
  const customer = await login('customer-test@example.com', 'Test@12345');
  if (customer.status !== 200) {
    fail('Customer login failed', customer.data);
    errors.push('customer_login');
  } else {
    pass('Customer logged in');
  }
  
  // First check if customer already has an active appointment
  const myApptsRes = await request('GET', '/appointments', null, customer.cookies);
  const existingAppts = myApptsRes.data?.data?.items || [];
  let appointmentId = null;
  
  // Cancel any active appointments so we start fresh
  for (const appt of existingAppts) {
    if (['requested', 'confirmed', 'reschedule_requested'].includes(appt.status)) {
      info(`Cancelling existing appointment ${appt._id} (status: ${appt.status})`);
      // Try customer cancel first, then admin cancel
      let cancelRes = await request('POST', `/appointments/${appt._id}/cancel`, { reason: 'Cleanup for E2E test' }, customer.cookies);
      if (cancelRes.status !== 200) {
        cancelRes = await request('POST', `/appointments/${appt._id}/cancel`, { reason: 'Cleanup for E2E test' }, admin.cookies);
      }
      if (cancelRes.status === 200) {
        pass(`Cancelled appointment ${appt._id}`);
      } else {
        info(`Cancel failed for ${appt._id}: ${cancelRes.status} - ${JSON.stringify(cancelRes.data?.error)}`);
      }
    }
  }
  
  // Book a new appointment — use a date 10 days from now to avoid slot conflicts
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 10);
  // Skip weekends
  if (futureDate.getDay() === 0) futureDate.setDate(futureDate.getDate() + 1);
  if (futureDate.getDay() === 6) futureDate.setDate(futureDate.getDate() + 2);
  const dateStr = futureDate.toISOString().split('T')[0];
  
  const slotsRes = await request('GET', `/appointments/slots?date=${dateStr}&type=office`, null, customer.cookies);
  info(`Slots for ${dateStr}: status=${slotsRes.status}`);
  if (slotsRes.data?.data) {
    const slotData = slotsRes.data.data;
    info(`Available slots: ${JSON.stringify(slotData).slice(0, 200)}...`);
  }
  
  const bookData = {
    date: dateStr,
    slotCode: '09:00',
    type: 'office',
    purpose: 'Site inspection for stainless steel railings',
  };
  
  const bookRes = await request('POST', '/appointments', bookData, customer.cookies);
  if (bookRes.status === 201) {
    appointmentId = bookRes.data?.data?._id;
    pass(`Appointment booked: ${appointmentId}`);
  } else {
    fail('Booking appointment failed', bookRes.data);
    errors.push('book_appointment');
  }
  
  // ━━━━━━━━━━━━ STEP 2: AGENT CONFIRMS + ASSIGNS SALES STAFF ━━━━━━━━━━━━
  let appointmentConfirmed = false;
  section('STEP 2: Agent Confirms Appointment & Assigns Sales Staff');
  
  const agent = await login('agent-test@example.com', 'Test@12345');
  if (agent.status !== 200) {
    fail('Agent login failed', agent.data);
    errors.push('agent_login');
  } else {
    pass('Agent logged in');
  }
  
  if (appointmentId) {
    // Check current status of the appointment
    const apptDetailRes = await request('GET', `/appointments/${appointmentId}`, null, agent.cookies);
    const apptStatus = apptDetailRes.data?.data?.status;
    info(`Appointment ${appointmentId} current status: ${apptStatus}`);
    
    if (apptStatus === 'requested') {
      // Use our test sales staff user ID (not the one from list endpoint which may return a different user)
      const salesStaffId = userIds.sales_staff;
      info(`Sales staff ID to assign: ${salesStaffId}`);
      
      const confirmRes = await request('POST', `/appointments/${appointmentId}/confirm`, {
        salesStaffId: salesStaffId
      }, agent.cookies);
      
      if (confirmRes.status === 200) {
        pass(`Appointment confirmed & sales staff assigned`);
        info(`Appointment status: ${confirmRes.data?.data?.status}`);
        appointmentConfirmed = true;
      } else {
        fail('Confirm appointment failed', confirmRes.data);
        errors.push('confirm_appointment');
      }
    } else if (apptStatus === 'confirmed') {
      info('Appointment already confirmed, skipping step 2');
      appointmentConfirmed = true;
    } else if (apptStatus === 'completed') {
      info('Appointment already completed, visit report should exist');
      appointmentConfirmed = true;
    } else {
      info(`Appointment in unexpected status: ${apptStatus}`);
    }
  }
  
  // ━━━━━━━━━━━━ STEP 3: SALES STAFF FILLS VISIT REPORT ━━━━━━━━━━━━
  section('STEP 3: Sales Staff Views Appointment & Fills Visit Report');
  
  const sales = await login('sales-test@example.com', 'Test@12345');
  if (sales.status !== 200) {
    fail('Sales Staff login failed', sales.data);
    errors.push('sales_login');
  } else {
    pass('Sales Staff logged in');
    info(`Sales cookies: ${Object.keys(sales.cookies).join(', ')}`);
  }
  
  // View their appointments
  const salesApptsRes = await request('GET', '/appointments?status=confirmed', null, sales.cookies);
  info(`Sales staff confirmed appointments: ${salesApptsRes.status} - ${salesApptsRes.data?.data?.items?.length ?? JSON.stringify(salesApptsRes.data).slice(0,200)}`);
  
  // Check visit report was auto-created
  let visitReportId = null;
  if (appointmentId && appointmentConfirmed) {
    const vrRes = await request('GET', `/visit-reports/appointment/${appointmentId}`, null, sales.cookies);
    if (vrRes.status === 200 && vrRes.data?.data) {
      visitReportId = vrRes.data.data._id;
      pass(`Visit report auto-created: ${visitReportId} (status: ${vrRes.data.data.status})`);
    } else {
      fail('Visit report not found for appointment', vrRes.data);
      errors.push('auto_create_visit_report');
    }
  } else if (appointmentId && !appointmentConfirmed) {
    info('Skipping visit report check because appointment was not confirmed');
    errors.push('appointment_not_confirmed');
  }
  
  // Fill in visit report
  if (visitReportId) {
    const updateVrRes = await request('PUT', `/visit-reports/${visitReportId}`, {
      visitType: 'ocular',
      actualVisitDateTime: new Date().toISOString(),
      measurements: {
        length: 500,
        width: 200,
        height: 100,
        thickness: 3,
        unit: 'cm',
        raw: 'Standard railings, 3 sections',
      },
      materials: 'Stainless Steel 304, Tempered Glass',
      finishes: 'Brushed Finish',
      preferredDesign: 'Modern minimalist with glass panels',
      customerRequirements: 'Customer wants railings for 2nd floor balcony. 3 sections total, approx 5m each.',
      notes: 'Site accessible. No special equipment needed.',
    }, sales.cookies);
    
    if (updateVrRes.status === 200) {
      pass('Visit report updated with site data');
    } else {
      fail('Update visit report failed', updateVrRes.data);
      errors.push('update_visit_report');
    }
    
    // Submit visit report (auto-completes appointment, auto-creates project)
    const submitVrRes = await request('POST', `/visit-reports/${visitReportId}/submit`, null, sales.cookies);
    if (submitVrRes.status === 200) {
      pass(`Visit report submitted (status: ${submitVrRes.data?.data?.status})`);
    } else {
      fail('Submit visit report failed', submitVrRes.data);
      errors.push('submit_visit_report');
    }
  }
  
  // ━━━━━━━━━━━━ STEP 4: CHECK AUTO-CREATED PROJECT ━━━━━━━━━━━━
  section('STEP 4: Verify Auto-Created Project');
  
  // The project should have been auto-created on visit report submit
  // Use admin cookies to see all projects
  const projectsRes = await request('GET', '/projects', null, admin.cookies);
  info(`Total projects: ${projectsRes.data?.data?.items?.length || projectsRes.data?.data?.length || 0}`);
  
  let projectId = null;
  const projectList = projectsRes.data?.data?.items || projectsRes.data?.data || [];
  if (Array.isArray(projectList) && projectList.length > 0 && appointmentId) {
    // Find the project linked to THIS appointment only.
    const matchingProject = projectList.find(p => p.appointmentId?.toString() === appointmentId);
    if (matchingProject) {
      projectId = matchingProject._id;
      pass(`Project found: ${projectId} (status: ${matchingProject.status}, title: ${matchingProject.title})`);
    } else {
      fail('No project linked to the newly created appointment', { appointmentId });
      errors.push('auto_create_project');
    }
  } else if (!appointmentId) {
    fail('Cannot locate project because appointment was not created');
    errors.push('no_appointment_for_project_lookup');
  } else {
    fail('No projects found after visit report submission');
    errors.push('auto_create_project');
  }
  
  // ━━━━━━━━━━━━ STEP 5: ENGINEER ASSIGNS + CREATES BLUEPRINT ━━━━━━━━━━━━
  section('STEP 5: Engineer Reviews, Creates Blueprint & Quotation');
  
  const engineer = await login('engineer-test@example.com', 'Test@12345');
  if (engineer.status !== 200) {
    fail('Engineer login failed', engineer.data);
    errors.push('engineer_login');
  } else {
    pass('Engineer logged in');
  }
  
  if (projectId) {
    // Admin assigns engineer to the project
    const engineerId = userIds.engineer || engineer.data?.data?.user?._id;
    const assignRes = await request('POST', `/projects/${projectId}/assign-engineers`, {
      engineerIds: [engineerId]
    }, admin.cookies);
    
    if (assignRes.status === 200) {
      pass(`Engineer assigned to project (status: ${assignRes.data?.data?.status})`);
    } else {
      fail('Assign engineer failed', assignRes.data);
      errors.push('assign_engineer');
    }
    
    // Upload blueprint with quotation (needs blueprintKey + costingKey)
    const blueprintRes = await request('POST', `/blueprints`, {
      projectId: projectId,
      blueprintKey: 'blueprints/test-blueprint.pdf',
      costingKey: 'blueprints/test-costing.pdf',
      quotation: {
        materials: 45000,
        labor: 25000,
        fees: 5000,
        total: 75000,
        breakdown: 'SS304 tubing, tempered glass panels, mounting hardware',
        estimatedDuration: '14 working days',
        engineerNotes: 'Standard installation. No welding on-site required.',
      }
    }, engineer.cookies);
    
    if (blueprintRes.status === 201 || blueprintRes.status === 200) {
      pass(`Blueprint uploaded with quotation: ${blueprintRes.data?.data?._id}`);
    } else {
      fail('Blueprint upload failed', blueprintRes.data);
      errors.push('upload_blueprint');
    }
  }
  
  // ━━━━━━━━━━━━ STEP 6: CUSTOMER REVIEWS & ACCEPTS BLUEPRINT ━━━━━━━━━━━━
  section('STEP 6: Customer Reviews & Accepts Blueprint');
  
  if (projectId) {
    // Get blueprints for this project (use /blueprints/project/:projectId)
    const bpListRes = await request('GET', `/blueprints/project/${projectId}`, null, customer.cookies);
    const bpList = bpListRes.data?.data;
    const bpCount = Array.isArray(bpList) ? bpList.length : bpList?.items?.length || 0;
    info(`Blueprints for project: ${bpCount}`);
    
    let blueprintId = null;
    if (Array.isArray(bpList) && bpList.length > 0) {
      blueprintId = bpList[0]._id;
      info(`Blueprint ID: ${blueprintId}, status: ${bpList[0].status}`);
    } else if (bpList?.items?.length > 0) {
      blueprintId = bpList.items[0]._id;
      info(`Blueprint ID: ${blueprintId}, status: ${bpList.items[0].status}`);
    }
    
    if (blueprintId) {
      // Customer approves blueprint component
      const approveBpRes = await request('POST', `/blueprints/${blueprintId}/approve`, {
        component: 'blueprint'
      }, customer.cookies);
      if (approveBpRes.status === 200) {
        pass(`Blueprint drawing approved by customer (status: ${approveBpRes.data?.data?.status})`);
      } else {
        fail('Blueprint approval failed', approveBpRes.data);
        errors.push('approve_blueprint');
      }
      
      // Customer approves costing component
      const approveCostRes = await request('POST', `/blueprints/${blueprintId}/approve`, {
        component: 'costing'
      }, customer.cookies);
      if (approveCostRes.status === 200) {
        pass(`Costing approved by customer (status: ${approveCostRes.data?.data?.status})`);
      } else {
        info(`Costing approval: ${approveCostRes.status} - ${JSON.stringify(approveCostRes.data?.error)}`);
      }
      
      // Check project status should now be APPROVED
      const projectCheck = await request('GET', `/projects/${projectId}`, null, admin.cookies);
      info(`Project status after approvals: ${projectCheck.data?.data?.status}`);
    }
  }
  
  // ━━━━━━━━━━━━ STEP 7: PAYMENT PLAN CREATION & FIRST PAYMENT ━━━━━━━━━━━━
  let projectInFabrication = false;
  section('STEP 7: Payment Plan & First Payment (30-40-30)');
  
  if (projectId) {
    // Cashier creates payment plan
    const cashier = await login('cashier-test@example.com', 'Test@12345');
    if (cashier.status !== 200) {
      fail('Cashier login failed', cashier.data);
      errors.push('cashier_login');
    } else {
      pass('Cashier logged in');
    }

    const projBeforePlan = await request('GET', `/projects/${projectId}`, null, admin.cookies);
    const projectStatusBeforePlan = projBeforePlan.data?.data?.status;
    info(`Project status before payment plan: ${projectStatusBeforePlan}`);
    if (projectStatusBeforePlan !== 'approved') {
      fail('Project is not in approved state for payment plan creation', {
        projectStatusBeforePlan,
      });
      errors.push('project_not_approved_for_payment');
    } else {
    
    // Create payment plan (POST /payments/plans, stages need percentages summing to 100)
    const paymentPlanRes = await request('POST', '/payments/plans', {
      projectId: projectId,
      totalAmount: 75000,
      stages: [
        { percentage: 30 },
        { percentage: 40 },
        { percentage: 30 },
      ]
    }, cashier.cookies);
    
    if (paymentPlanRes.status === 201 || paymentPlanRes.status === 200) {
      pass(`Payment plan created: ${paymentPlanRes.data?.data?._id}`);
    } else {
      fail('Create payment plan failed', paymentPlanRes.data);
      errors.push('create_payment_plan');
    }
    const paymentPlanCreated = paymentPlanRes.status === 201 || paymentPlanRes.status === 200;
    if (paymentPlanCreated) {
    
    // Check project status (should be PAYMENT_PENDING)
    const projAfterPlan = await request('GET', `/projects/${projectId}`, null, admin.cookies);
    info(`Project status after payment plan: ${projAfterPlan.data?.data?.status}`);
    
    // Get payment plan to see stage IDs
    const planRes = await request('GET', `/payments/plan/${projectId}`, null, customer.cookies);
    info(`Payment plan stages: ${planRes.data?.data?.stages?.length || 0}`);
    
    const plan = planRes.data?.data;
    const stages = plan?.stages || [];
    
    if (stages.length > 0) {
      // Submit and verify all 3 stages so project transitions to fabrication
      for (let i = 0; i < stages.length; i++) {
        const stage = stages[i];
        const sId = stage.stageId || stage._id;
        info(`Processing payment stage ${i + 1}: ${sId} (${stage.percentage}%, $${stage.amount})`);
        
        // Customer submits proof (POST /payments/submit-proof)
        const proofRes = await request('POST', `/payments/submit-proof`, {
          stageId: sId,
          method: 'paymongo',
          amountPaid: stage.amount,
          referenceNumber: `PMNG-${10000 + i}`,
          proofKey: `proofs/payment-proof-${i + 1}.jpg`,
        }, customer.cookies);
        
        if (proofRes.status === 200 || proofRes.status === 201) {
          pass(`Payment proof submitted for stage ${i + 1}`);
          const paymentId = proofRes.data?.data?._id;
          
          // Cashier verifies the payment (POST /payments/:id/verify)
          if (paymentId) {
            const verifyRes = await request('POST', `/payments/${paymentId}/verify`, null, cashier.cookies);
            if (verifyRes.status === 200) {
              pass(`Payment stage ${i + 1} verified by cashier`);
            } else {
              fail(`Verify payment stage ${i + 1} failed`, verifyRes.data);
              errors.push(`verify_payment_${i + 1}`);
            }
          }
        } else {
          fail(`Submit payment proof stage ${i + 1} failed`, proofRes.data);
          errors.push(`submit_proof_${i + 1}`);
        }
      }
      
      // Check project status — should now be FABRICATION
      const projAfterPayments = await request('GET', `/projects/${projectId}`, null, admin.cookies);
      const projectStatusAfterPayments = projAfterPayments.data?.data?.status;
      info(`Project status after all payments verified: ${projectStatusAfterPayments}`);
      if (projectStatusAfterPayments === 'fabrication') {
        projectInFabrication = true;
      }
    } else {
      info('No stages found in payment plan');
      errors.push('no_stages');
    }
    }
    }
  }
  
  // ━━━━━━━━━━━━ STEP 8: FABRICATION FLOW ━━━━━━━━━━━━
  section('STEP 8: Fabrication Flow');
  
  const fabricator = await login('fabricator-test@example.com', 'Test@12345');
  if (fabricator.status !== 200) {
    fail('Fabricator login failed', fabricator.data);
    errors.push('fabricator_login');
  } else {
    pass('Fabricator logged in');
  }
  
  if (projectId && projectInFabrication) {
    // Check project status
    const projCheck = await request('GET', `/projects/${projectId}`, null, admin.cookies);
    info(`Project status before fabrication: ${projCheck.data?.data?.status}`);
    
    // Assign fabrication staff to project
    const fabAssignRes = await request('POST', `/projects/${projectId}/assign-fabrication`, {
      fabricationLeadId: userIds.fabrication_staff || fabricator.data?.data?.user?._id,
      fabricationAssistantIds: [],
    }, admin.cookies);
    if (fabAssignRes.status === 200) {
      pass(`Fabrication staff assigned (status: ${fabAssignRes.data?.data?.status})`);
    } else {
      info(`Fab assign: ${fabAssignRes.status} - ${JSON.stringify(fabAssignRes.data?.error)}`);
    }
    
    // Each fabrication stage = a new POST /fabrication (no transition endpoint)
    // Check current fabrication status first
    const fabStatusRes = await request('GET', `/fabrication/project/${projectId}/status`, null, fabricator.cookies);
    const currentFabStatus = fabStatusRes.data?.data?.status;
    info(`Current fabrication status: ${currentFabStatus || 'none'}`);
    
    const allStages = ['queued', 'material_prep', 'cutting', 'welding', 'finishing', 'quality_check', 'ready_for_delivery', 'done'];
    // When no updates exist, current status defaults to 'queued', so skip it
    // Also skip stages already completed
    const effectiveStatus = currentFabStatus || 'queued';
    const startIdx = Math.max(allStages.indexOf(effectiveStatus) + 1, 1); // always start at material_prep minimum
    const stages = allStages.slice(startIdx);
    
    for (const stage of stages) {
      const fabRes = await request('POST', '/fabrication', {
        projectId: projectId,
        status: stage,
        notes: `Stage update: ${stage}`,
        photoKeys: ['fabrication/stage-photo.jpg'],
      }, fabricator.cookies);
      
      if (fabRes.status === 201 || fabRes.status === 200) {
        pass(`Fabrication → ${stage}`);
      } else {
        fail(`Fabrication ${stage} failed`, fabRes.data);
        errors.push(`fab_${stage}`);
        break;
      }
    }
    
    // Final project status check
    const finalProj = await request('GET', `/projects/${projectId}`, null, admin.cookies);
    info(`Final project status: ${finalProj.data?.data?.status}`);
  } else if (projectId && !projectInFabrication) {
    info('Skipping fabrication flow because project is not yet in fabrication status');
    errors.push('project_not_in_fabrication');
  }
  
  // ━━━━━━━━━━━━ RESULTS ━━━━━━━━━━━━
  section('TEST RESULTS');
  if (errors.length === 0) {
    pass('ALL PIPELINE TESTS PASSED! 🎉');
  } else {
    fail(`${errors.length} step(s) had issues: ${errors.join(', ')}`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
