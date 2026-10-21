import { GHI_GENDERS, type GhiGender } from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

/**
 * An employee identity (Requirement 17): one employee of one company, shared by GMC, GPA and
 * GTLI. It holds the employee's own details only; sums insured, salaries and plans stay on each
 * case's member (17.8).
 */
export interface EmployeeIdentityDoc {
  _id: Types.ObjectId;
  clientId: Types.ObjectId;
  /** The employee ID upper-cased without spaces; unique per company. */
  employeeKey: string;
  employeeId: string;
  name: string;
  nameKey: string;
  gender: GhiGender;
  dateOfBirth: string;
  dateOfJoining: string | null;
  source: 'CENSUS' | 'STARTUP_LINK' | 'RESOLUTION';
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const employeeSchema = new Schema<EmployeeIdentityDoc>(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    employeeKey: { type: String, required: true },
    employeeId: { type: String, required: true },
    name: { type: String, required: true },
    nameKey: { type: String, required: true },
    gender: { type: String, enum: GHI_GENDERS, required: true },
    dateOfBirth: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    dateOfJoining: { type: String, default: null },
    source: { type: String, enum: ['CENSUS', 'STARTUP_LINK', 'RESOLUTION'], required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'eb_employees', timestamps: true, strict: 'throw' },
);
employeeSchema.index({ clientId: 1, employeeKey: 1 }, { unique: true });
employeeSchema.index({ clientId: 1, nameKey: 1 });

export const EmployeeIdentityModel = model<EmployeeIdentityDoc>('EbEmployee', employeeSchema);
