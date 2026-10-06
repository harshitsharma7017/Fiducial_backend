import { gstinCheckCharacter, type ImportEntity } from '../../shared/index.ts';

// Fictional sample rows for each import template. Names, people and emails are invented (emails
// use the reserved .example domain). Occupancy codes and pincodes are real entries of the IIB
// master, so the rows pass the import against it.

/** A valid GSTIN on the placeholder PAN ZZZZZnnnnZ: no real PAN has Z as its fourth letter. */
function sampleGstin(stateCode: string, serial: number): string {
  const first14 = `${stateCode}ZZZZZ${String(serial).padStart(4, '0')}Z1Z`;
  return `${first14}${gstinCheckCharacter(first14)}`;
}

const GSTIN = {
  sahyadri: sampleGstin('27', 1),
  nilgiri: sampleGstin('33', 2),
  deccan: sampleGstin('29', 3),
  sabarmati: sampleGstin('24', 4),
  yamuna: sampleGstin('07', 5),
};

const CLIENTS: Record<string, string>[] = [
  {
    name: 'Sahyadri Textiles Pvt Ltd',
    gstin: GSTIN.sahyadri,
    line1: 'Plot 14, MIDC Industrial Area',
    line2: 'Kalyan Road',
    city: 'Bhiwandi',
    state: 'Maharashtra',
    pincode: '421302',
    natureOfBusiness: 'Cotton yarn spinning',
    occupancyCode: '2189',
    contact1Name: 'Anil Deshmukh',
    contact1Designation: 'Finance Head',
    contact1Email: 'anil.deshmukh@sahyadri.example',
    contact1Phone: '+91 22 4000 1100',
    contact2Name: 'Sneha Kulkarni',
    contact2Designation: 'Plant Manager',
    contact2Email: '',
    contact2Phone: '+91 98200 11223',
  },
  {
    name: 'Nilgiri Pharma Labs Ltd',
    gstin: GSTIN.nilgiri,
    line1: '12 SIDCO Industrial Estate',
    line2: 'Guindy',
    city: 'Chennai',
    state: 'Tamil Nadu',
    pincode: '600032',
    natureOfBusiness: 'Pharmaceutical formulations',
    occupancyCode: '2044',
    contact1Name: 'Kavitha Raman',
    contact1Designation: 'CFO',
    contact1Email: 'kavitha.raman@nilgiri.example',
    contact1Phone: '',
  },
  {
    name: 'Deccan Cold Chain LLP',
    gstin: GSTIN.deccan,
    line1: '45 Peenya Industrial Area, Phase 2',
    line2: '',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560058',
    natureOfBusiness: 'Cold storage and warehousing',
    occupancyCode: '4007',
    contact1Name: 'Rohit Shetty',
    contact1Designation: 'Partner',
    contact1Email: 'rohit@deccancold.example',
    contact1Phone: '+91 80 2839 4400',
  },
  {
    name: 'Sabarmati Plastics Pvt Ltd',
    gstin: GSTIN.sabarmati,
    line1: 'Survey 221, GIDC Vatva',
    line2: '',
    city: 'Ahmedabad',
    state: 'Gujarat',
    pincode: '382445',
    natureOfBusiness: 'Injection-moulded plastic goods',
    occupancyCode: '2148',
    contact1Name: 'Hetal Patel',
    contact1Designation: 'Director',
    contact1Email: 'hetal.patel@sabarmati.example',
    contact1Phone: '+91 79 2589 1020',
  },
  {
    name: 'Yamuna Hospitality Pvt Ltd',
    gstin: GSTIN.yamuna,
    line1: '8 Nehru Place',
    line2: '',
    city: 'New Delhi',
    state: 'Delhi',
    pincode: '110020',
    natureOfBusiness: 'Hotels and restaurants',
    occupancyCode: '1017',
    contact1Name: 'Arjun Malhotra',
    contact1Designation: 'General Manager',
    contact1Email: 'arjun.malhotra@yamuna.example',
    contact1Phone: '',
  },
  {
    // No GSTIN: a small unregistered insured. Its locations are matched by name.
    name: 'Shree Ganesh Traders',
    gstin: '',
    line1: 'Shop 3, Market Yard',
    line2: '',
    city: 'Pune',
    state: 'Maharashtra',
    pincode: '411001',
    natureOfBusiness: 'Wholesale grain trading',
    occupancyCode: '4001',
    contact1Name: 'Ganesh Jadhav',
    contact1Designation: 'Proprietor',
    contact1Email: '',
    contact1Phone: '+91 98220 33445',
  },
];

function location(
  client: { gstin?: string; name?: string },
  name: string,
  line1: string,
  city: string,
  pincode: string,
  occupancyCode = '',
): Record<string, string> {
  return {
    clientGstin: client.gstin ?? '',
    clientName: client.name ?? '',
    name,
    line1,
    line2: '',
    city,
    pincode,
    occupancyCode,
  };
}

const LOCATIONS: Record<string, string>[] = [
  location({ gstin: GSTIN.sahyadri }, 'Spinning unit 1', 'Plot 14, MIDC', 'Bhiwandi', '421302'),
  location({ gstin: GSTIN.sahyadri }, 'Spinning unit 2', 'Plot 15, MIDC', 'Bhiwandi', '421302'),
  location(
    { gstin: GSTIN.sahyadri },
    'Finished goods godown',
    'Gala 7, Rahnal Village',
    'Bhiwandi',
    '421302',
    '4001',
  ),
  location(
    { gstin: GSTIN.sahyadri },
    'Mumbai sales office',
    '501 Business Park, Andheri East',
    'Mumbai',
    '400093',
    '1007',
  ),
  location(
    { gstin: GSTIN.nilgiri },
    'Guindy plant',
    '12 SIDCO Industrial Estate',
    'Chennai',
    '600032',
  ),
  location(
    { gstin: GSTIN.nilgiri },
    'Coimbatore depot',
    '22 Avinashi Road',
    'Coimbatore',
    '641001',
    '4001',
  ),
  location(
    { gstin: GSTIN.deccan },
    'Peenya cold store',
    '45 Peenya Phase 2',
    'Bengaluru',
    '560058',
  ),
  location(
    { gstin: GSTIN.deccan },
    'City office',
    '3rd Floor, 18 MG Road',
    'Bengaluru',
    '560001',
    '1007',
  ),
  location(
    { gstin: GSTIN.sabarmati },
    'Vatva plant',
    'Survey 221, GIDC Vatva',
    'Ahmedabad',
    '382445',
  ),
  location(
    { gstin: GSTIN.sabarmati },
    'Surat warehouse',
    'Plot 9, Sachin GIDC',
    'Surat',
    '395003',
    '4001',
  ),
  location({ gstin: GSTIN.yamuna }, 'Nehru Place hotel', '8 Nehru Place', 'New Delhi', '110020'),
  location(
    { name: 'Shree Ganesh Traders' },
    'Market Yard godown',
    'Godown 11, Market Yard',
    'Pune',
    '411018',
  ),
];

function insurer(
  company: string,
  branch: string,
  rfqEmails: string,
  contact: [name: string, designation: string, email: string, phone: string],
): Record<string, string> {
  const [contact1Name, contact1Designation, contact1Email, contact1Phone] = contact;
  return {
    company,
    branch,
    rfqEmails,
    contact1Name,
    contact1Designation,
    contact1Email,
    contact1Phone,
  };
}

const INSURERS: Record<string, string>[] = [
  insurer(
    'Suraksha General Insurance Co. Ltd',
    'Fort, Mumbai',
    'fire.uw.mumbai@suraksha.example, property.mumbai@suraksha.example',
    ['Ravi Kumar', 'Senior Underwriter', 'ravi.kumar@suraksha.example', '+91 22 6600 1200'],
  ),
  insurer(
    'Suraksha General Insurance Co. Ltd',
    'Anna Salai, Chennai',
    'fire.uw.chennai@suraksha.example',
    ['Lakshmi Iyer', 'Branch Manager', 'lakshmi.iyer@suraksha.example', ''],
  ),
  insurer(
    'Kavach General Insurance Ltd',
    'Bandra Kurla Complex, Mumbai',
    'property.rfq@kavach.example',
    ['Farhan Qureshi', 'Underwriter', 'farhan.q@kavach.example', '+91 22 6789 0011'],
  ),
  insurer(
    'Abhay Insurance Co. Ltd',
    'MG Road, Bengaluru',
    'commercial.blr@abhay.example; fire.blr@abhay.example',
    ['Divya Rao', 'Underwriting Manager', 'divya.rao@abhay.example', ''],
  ),
  insurer(
    'Dhruva General Insurance Ltd',
    'Ashram Road, Ahmedabad',
    'rfq.ahmedabad@dhruva.example',
    ['Mehul Shah', 'Relationship Manager', '', '+91 79 4000 7788'],
  ),
  insurer('Nirbhay Assurance Ltd', 'Connaught Place, New Delhi', 'property.delhi@nirbhay.example', [
    'Simran Kaur',
    'Underwriter',
    'simran.kaur@nirbhay.example',
    '+91 11 4300 5500',
  ]),
];

export const SAMPLE_ROWS: Record<ImportEntity, readonly Record<string, string>[]> = {
  clients: CLIENTS,
  'client-locations': LOCATIONS,
  insurers: INSURERS,
};
