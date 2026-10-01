import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Project, ProjectCounter } from '../models/index.js';

dotenv.config();

async function backfill() {
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/rmv_system';
  
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    const legacyProjects = await Project.find({
      projectNumber: /^RMV-\d{4}-\d{5}$/,
    }).sort({ createdAt: 1 });

    for (const project of legacyProjects) {
      const projectNumber = project.projectNumber.replace(/^RMV-/, 'PRJ-');
      const duplicate = await Project.exists({
        _id: { $ne: project._id },
        projectNumber,
      });
      if (duplicate) {
        throw new Error(`Cannot migrate ${project.projectNumber}: ${projectNumber} already exists`);
      }

      project.projectNumber = projectNumber;
      await project.save();
      console.log(`Migrated ${project._id}: ${projectNumber}`);
    }

    // Find projects without project numbers
    const projects = await Project.find({
      $or: [
        { projectNumber: { $exists: false } },
        { projectNumber: '' },
        { projectNumber: null },
      ],
    }).sort({ createdAt: 1 });

    if (legacyProjects.length === 0 && projects.length === 0) {
      console.log('No project IDs need migration or backfilling.');
      process.exit(0);
    }

    console.log(`Migrated ${legacyProjects.length} legacy project IDs; found ${projects.length} missing project IDs to backfill.`);

    // Group projects by year of creation
    const projectsByYear: Record<number, typeof projects> = {};
    for (const project of projects) {
      const year = new Date(project.createdAt).getFullYear();
      if (!projectsByYear[year]) {
        projectsByYear[year] = [];
      }
      projectsByYear[year].push(project);
    }

    for (const yearStr in projectsByYear) {
      const year = parseInt(yearStr);
      const yearProjects = projectsByYear[year];
      
      console.log(`Processing ${yearProjects.length} projects for year ${year}...`);

      // Initialize or get the counter for this year
      let counter = await ProjectCounter.findOne({ year });
      if (!counter) {
        counter = await ProjectCounter.create({ year, lastSeq: 0 });
      }

      for (const project of yearProjects) {
        counter.lastSeq += 1;
        const seqStr = String(counter.lastSeq).padStart(5, '0');
        const projectNumber = `PRJ-${year}-${seqStr}`;
        
        project.projectNumber = projectNumber;
        await project.save();
        console.log(`Assigned ${projectNumber} to project ${project._id} (${project.title})`);
      }

      await counter.save();
    }

    console.log('Backfill completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('Backfill failed:', error);
    process.exit(1);
  }
}

backfill();
