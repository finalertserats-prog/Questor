/**
 * Seed for the shared role catalog, extracted from "2026 Global Job
 * Architecture - Mother Portfolio V2". Only titles, domains, families, market
 * signal and the non-template purposes were kept: the source's responsibility
 * bullets and aliases were template filler.
 *
 * A TypeScript module rather than JSON so the production build compiles it
 * like any other source file - a JSON import needs an import attribute whose
 * syntax differs across Node versions.
 */

export interface RoleCatalogSeedRole {
  readonly title: string;
  readonly aliases: readonly string[];
  readonly family: string;
  readonly marketSignal: string;
  readonly purpose: string;
}

export interface RoleCatalogSeedDomain {
  readonly order: number;
  readonly name: string;
  readonly summary: string;
  readonly roles: readonly RoleCatalogSeedRole[];
}

export interface RoleCatalogSeed {
  readonly version: string;
  readonly source: string;
  readonly domains: readonly RoleCatalogSeedDomain[];
}

export const ROLE_CATALOG: RoleCatalogSeed = {
 "version": "2026-09-v2",
 "source": "2026 Global Job Architecture - Mother Portfolio V2 (titles, domains and families only)",
 "domains": [
  {
   "order": 1,
   "name": "Frontier AI, Applied AI & Forward Deployed Engineering",
   "summary": "Turn frontier and applied ai capabilities into safe, measurable production outcomes.",
   "roles": [
    {
     "title": "AI Research Scientist",
     "aliases": [],
     "family": "Research & Applied Science",
     "marketSignal": "High-growth / expanding",
     "purpose": ""
    },
    {
     "title": "Research Engineer - AI",
     "aliases": [],
     "family": "Research & Applied Science",
     "marketSignal": "High-growth / expanding",
     "purpose": ""
    },
    {
     "title": "Applied AI Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to turn frontier and applied AI capabilities into safe, measurable production outcomes."
    },
    {
     "title": "Generative AI Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to turn frontier and applied AI capabilities into safe, measurable production outcomes."
    },
    {
     "title": "AI Agent Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Emerging / rapidly formalising",
     "purpose": "Design, build and operate agentic AI systems that can plan, use tools, access enterprise data and execute multi-step workflows safely and reliably."
    },
    {
     "title": "AI Evals Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Emerging / rapidly formalising",
     "purpose": "Build rigorous evaluation systems that measure AI model and application quality, safety, robustness and real-world task performance before and after deployment."
    },
    {
     "title": "AI Safety Researcher",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "High-growth / expanding",
     "purpose": ""
    },
    {
     "title": "Model Behavior Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Emerging / rapidly formalising",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to turn frontier and applied AI capabilities into safe, measurable production outcomes."
    },
    {
     "title": "Forward Deployed Engineer",
     "aliases": [
      "FDE"
     ],
     "family": "Forward Deployed / Deployment Engineering",
     "marketSignal": "Emerging / rapidly formalising",
     "purpose": "Own complex end-to-end deployments of advanced AI systems with strategic customers, from problem discovery and technical scoping through prototyping, production rollout, adoption and feedback into the core product/model roadmap."
    },
    {
     "title": "Forward Deployed Software Engineer",
     "aliases": [
      "FDSWE"
     ],
     "family": "Forward Deployed / Deployment Engineering",
     "marketSignal": "Emerging / rapidly formalising",
     "purpose": "Build scalable custom software and reusable abstractions for customer deployments, working alongside forward-deployed and account teams to solve difficult real-world problems with production-quality code."
    },
    {
     "title": "Technical Deployment Lead - AI",
     "aliases": [],
     "family": "Forward Deployed / Deployment Engineering",
     "marketSignal": "High-growth / expanding",
     "purpose": ""
    },
    {
     "title": "Applied AI Architect",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to turn frontier and applied AI capabilities into safe, measurable production outcomes."
    },
    {
     "title": "AI Solutions Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to turn frontier and applied AI capabilities into safe, measurable production outcomes."
    },
    {
     "title": "AI Product Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to turn frontier and applied AI capabilities into safe, measurable production outcomes."
    },
    {
     "title": "AI Developer Experience Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to turn frontier and applied AI capabilities into safe, measurable production outcomes."
    }
   ]
  },
  {
   "order": 2,
   "name": "Machine Learning Platforms, AI Infrastructure & MLOps",
   "summary": "Build the infrastructure, platforms and operating systems that make ml/ai development reliable and scalable.",
   "roles": [
    {
     "title": "Machine Learning Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to build the infrastructure, platforms and operating systems that make ML/AI development reliable and scalable."
    },
    {
     "title": "MLOps Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to build the infrastructure, platforms and operating systems that make ML/AI development reliable and scalable."
    },
    {
     "title": "ML Platform Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to build the infrastructure, platforms and operating systems that make ML/AI development reliable and scalable."
    },
    {
     "title": "AI Infrastructure Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to build the infrastructure, platforms and operating systems that make ML/AI development reliable and scalable."
    },
    {
     "title": "Inference Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to build the infrastructure, platforms and operating systems that make ML/AI development reliable and scalable."
    },
    {
     "title": "Distributed Training Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to build the infrastructure, platforms and operating systems that make ML/AI development reliable and scalable."
    },
    {
     "title": "GPU Systems Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to build the infrastructure, platforms and operating systems that make ML/AI development reliable and scalable."
    },
    {
     "title": "AI Compiler Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to build the infrastructure, platforms and operating systems that make ML/AI development reliable and scalable."
    },
    {
     "title": "Model Optimization Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to build the infrastructure, platforms and operating systems that make ML/AI development reliable and scalable."
    },
    {
     "title": "Feature Platform Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to build the infrastructure, platforms and operating systems that make ML/AI development reliable and scalable."
    },
    {
     "title": "Vector Search Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to build the infrastructure, platforms and operating systems that make ML/AI development reliable and scalable."
    },
    {
     "title": "LLMOps Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Emerging / rapidly formalising",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to build the infrastructure, platforms and operating systems that make ML/AI development reliable and scalable."
    },
    {
     "title": "AI Observability Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Emerging / rapidly formalising",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to build the infrastructure, platforms and operating systems that make ML/AI development reliable and scalable."
    },
    {
     "title": "Synthetic Data Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Emerging / rapidly formalising",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to build the infrastructure, platforms and operating systems that make ML/AI development reliable and scalable."
    }
   ]
  },
  {
   "order": 3,
   "name": "Data, Analytics & Decision Science",
   "summary": "Convert trusted data into reusable products, models, metrics and decisions.",
   "roles": [
    {
     "title": "Data Scientist",
     "aliases": [],
     "family": "Research & Applied Science",
     "marketSignal": "High-growth / expanding",
     "purpose": ""
    },
    {
     "title": "Senior Data Scientist",
     "aliases": [],
     "family": "Research & Applied Science",
     "marketSignal": "High-growth / expanding",
     "purpose": ""
    },
    {
     "title": "Decision Scientist",
     "aliases": [],
     "family": "Research & Applied Science",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Data Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to convert trusted data into reusable products, models, metrics and decisions."
    },
    {
     "title": "Analytics Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to convert trusted data into reusable products, models, metrics and decisions."
    },
    {
     "title": "Business Intelligence Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to convert trusted data into reusable products, models, metrics and decisions."
    },
    {
     "title": "Data Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "High-growth / expanding",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation convert trusted data into reusable products, models, metrics and decisions."
    },
    {
     "title": "Product Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation convert trusted data into reusable products, models, metrics and decisions."
    },
    {
     "title": "Operations Research Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation convert trusted data into reusable products, models, metrics and decisions."
    },
    {
     "title": "Statistician",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation convert trusted data into reusable products, models, metrics and decisions."
    },
    {
     "title": "Data Architect",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to convert trusted data into reusable products, models, metrics and decisions."
    },
    {
     "title": "Data Product Manager",
     "aliases": [],
     "family": "Product Management",
     "marketSignal": "High-growth / expanding",
     "purpose": "Own product outcomes, prioritization and cross-functional delivery so the organisation can convert trusted data into reusable products, models, metrics and decisions."
    },
    {
     "title": "Data Governance Lead",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can convert trusted data into reusable products, models, metrics and decisions."
    },
    {
     "title": "Master Data Management Lead",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can convert trusted data into reusable products, models, metrics and decisions."
    }
   ]
  },
  {
   "order": 4,
   "name": "Software Engineering & Architecture",
   "summary": "Design, build and operate reliable software products and enterprise systems.",
   "roles": [
    {
     "title": "Software Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, build and operate reliable software products and enterprise systems."
    },
    {
     "title": "Backend Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, build and operate reliable software products and enterprise systems."
    },
    {
     "title": "Frontend Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, build and operate reliable software products and enterprise systems."
    },
    {
     "title": "Full-Stack Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, build and operate reliable software products and enterprise systems."
    },
    {
     "title": "Mobile Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, build and operate reliable software products and enterprise systems."
    },
    {
     "title": "Staff Software Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, build and operate reliable software products and enterprise systems."
    },
    {
     "title": "Principal Software Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, build and operate reliable software products and enterprise systems."
    },
    {
     "title": "Solutions Architect",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, build and operate reliable software products and enterprise systems."
    },
    {
     "title": "Enterprise Architect",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, build and operate reliable software products and enterprise systems."
    },
    {
     "title": "API & Integration Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, build and operate reliable software products and enterprise systems."
    },
    {
     "title": "Developer Productivity Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, build and operate reliable software products and enterprise systems."
    },
    {
     "title": "Quality Engineer / SDET",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, build and operate reliable software products and enterprise systems."
    },
    {
     "title": "Engineering Manager",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, build and operate reliable software products and enterprise systems."
    },
    {
     "title": "Developer Relations Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, build and operate reliable software products and enterprise systems."
    }
   ]
  },
  {
   "order": 5,
   "name": "Cloud, Platform Engineering, DevOps & Reliability",
   "summary": "Provide secure, automated, scalable infrastructure and internal platforms.",
   "roles": [
    {
     "title": "Cloud Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to provide secure, automated, scalable infrastructure and internal platforms."
    },
    {
     "title": "Cloud Solutions Architect",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to provide secure, automated, scalable infrastructure and internal platforms."
    },
    {
     "title": "Platform Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to provide secure, automated, scalable infrastructure and internal platforms."
    },
    {
     "title": "DevOps Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to provide secure, automated, scalable infrastructure and internal platforms."
    },
    {
     "title": "Site Reliability Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to provide secure, automated, scalable infrastructure and internal platforms."
    },
    {
     "title": "Kubernetes Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to provide secure, automated, scalable infrastructure and internal platforms."
    },
    {
     "title": "Infrastructure Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to provide secure, automated, scalable infrastructure and internal platforms."
    },
    {
     "title": "Infrastructure Automation Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to provide secure, automated, scalable infrastructure and internal platforms."
    },
    {
     "title": "Observability Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to provide secure, automated, scalable infrastructure and internal platforms."
    },
    {
     "title": "Release Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to provide secure, automated, scalable infrastructure and internal platforms."
    },
    {
     "title": "Cloud FinOps Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "High-growth / expanding",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can provide secure, automated, scalable infrastructure and internal platforms."
    },
    {
     "title": "Capacity Planning Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to provide secure, automated, scalable infrastructure and internal platforms."
    },
    {
     "title": "Resilience Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to provide secure, automated, scalable infrastructure and internal platforms."
    },
    {
     "title": "Technical Operations Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to provide secure, automated, scalable infrastructure and internal platforms."
    }
   ]
  },
  {
   "order": 6,
   "name": "Cybersecurity, Privacy, Trust & Safety",
   "summary": "Reduce cyber, privacy, abuse and technology risk while enabling safe digital operations.",
   "roles": [
    {
     "title": "Information Security Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "High-growth / expanding",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation reduce cyber, privacy, abuse and technology risk while enabling safe digital operations."
    },
    {
     "title": "Security Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to reduce cyber, privacy, abuse and technology risk while enabling safe digital operations."
    },
    {
     "title": "Security Architect",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to reduce cyber, privacy, abuse and technology risk while enabling safe digital operations."
    },
    {
     "title": "Cloud Security Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to reduce cyber, privacy, abuse and technology risk while enabling safe digital operations."
    },
    {
     "title": "Application Security Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to reduce cyber, privacy, abuse and technology risk while enabling safe digital operations."
    },
    {
     "title": "Product Security Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to reduce cyber, privacy, abuse and technology risk while enabling safe digital operations."
    },
    {
     "title": "Security Operations Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "High-growth / expanding",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation reduce cyber, privacy, abuse and technology risk while enabling safe digital operations."
    },
    {
     "title": "Detection Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to reduce cyber, privacy, abuse and technology risk while enabling safe digital operations."
    },
    {
     "title": "Incident Response Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to reduce cyber, privacy, abuse and technology risk while enabling safe digital operations."
    },
    {
     "title": "Threat Intelligence Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation reduce cyber, privacy, abuse and technology risk while enabling safe digital operations."
    },
    {
     "title": "Identity & Access Management Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to reduce cyber, privacy, abuse and technology risk while enabling safe digital operations."
    },
    {
     "title": "Privacy Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to reduce cyber, privacy, abuse and technology risk while enabling safe digital operations."
    },
    {
     "title": "AI Security Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Emerging / rapidly formalising",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to reduce cyber, privacy, abuse and technology risk while enabling safe digital operations."
    },
    {
     "title": "Trust & Safety Operations Lead",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can reduce cyber, privacy, abuse and technology risk while enabling safe digital operations."
    },
    {
     "title": "GRC Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can reduce cyber, privacy, abuse and technology risk while enabling safe digital operations."
    }
   ]
  },
  {
   "order": 7,
   "name": "Product Management, Design & Digital Experience",
   "summary": "Discover valuable problems and lead teams to deliver usable, viable and measurable products and experiences.",
   "roles": [
    {
     "title": "Product Manager",
     "aliases": [],
     "family": "Product Management",
     "marketSignal": "Established / evolving",
     "purpose": "Own product outcomes, prioritization and cross-functional delivery so the organisation can discover valuable problems and lead teams to deliver usable, viable and measurable products and experiences."
    },
    {
     "title": "Technical Product Manager",
     "aliases": [],
     "family": "Product Management",
     "marketSignal": "Established / evolving",
     "purpose": "Own product outcomes, prioritization and cross-functional delivery so the organisation can discover valuable problems and lead teams to deliver usable, viable and measurable products and experiences."
    },
    {
     "title": "AI Product Manager",
     "aliases": [],
     "family": "Product Management",
     "marketSignal": "High-growth / expanding",
     "purpose": "Own product outcomes, prioritization and cross-functional delivery so the organisation can discover valuable problems and lead teams to deliver usable, viable and measurable products and experiences."
    },
    {
     "title": "Growth Product Manager",
     "aliases": [],
     "family": "Product Management",
     "marketSignal": "Established / evolving",
     "purpose": "Own product outcomes, prioritization and cross-functional delivery so the organisation can discover valuable problems and lead teams to deliver usable, viable and measurable products and experiences."
    },
    {
     "title": "Platform Product Manager",
     "aliases": [],
     "family": "Product Management",
     "marketSignal": "High-growth / expanding",
     "purpose": "Own product outcomes, prioritization and cross-functional delivery so the organisation can discover valuable problems and lead teams to deliver usable, viable and measurable products and experiences."
    },
    {
     "title": "Product Operations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can discover valuable problems and lead teams to deliver usable, viable and measurable products and experiences."
    },
    {
     "title": "Product Designer",
     "aliases": [],
     "family": "Design / Creative / Production",
     "marketSignal": "Established / evolving",
     "purpose": "Research, design and deliver experiences or creative outputs that help the organisation discover valuable problems and lead teams to deliver usable, viable and measurable products and experiences."
    },
    {
     "title": "UX Designer",
     "aliases": [],
     "family": "Design / Creative / Production",
     "marketSignal": "Established / evolving",
     "purpose": "Research, design and deliver experiences or creative outputs that help the organisation discover valuable problems and lead teams to deliver usable, viable and measurable products and experiences."
    },
    {
     "title": "UX Researcher",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Service Designer",
     "aliases": [],
     "family": "Design / Creative / Production",
     "marketSignal": "Established / evolving",
     "purpose": "Research, design and deliver experiences or creative outputs that help the organisation discover valuable problems and lead teams to deliver usable, viable and measurable products and experiences."
    },
    {
     "title": "Design Systems Lead",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can discover valuable problems and lead teams to deliver usable, viable and measurable products and experiences."
    },
    {
     "title": "Content Designer",
     "aliases": [],
     "family": "Design / Creative / Production",
     "marketSignal": "Established / evolving",
     "purpose": "Research, design and deliver experiences or creative outputs that help the organisation discover valuable problems and lead teams to deliver usable, viable and measurable products and experiences."
    },
    {
     "title": "Product Strategy Lead",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can discover valuable problems and lead teams to deliver usable, viable and measurable products and experiences."
    },
    {
     "title": "Digital Experience Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can discover valuable problems and lead teams to deliver usable, viable and measurable products and experiences."
    }
   ]
  },
  {
   "order": 8,
   "name": "Semiconductors, Electronics & Embedded Systems",
   "summary": "Design, verify, manufacture and deploy semiconductor and embedded-system capabilities.",
   "roles": [
    {
     "title": "ASIC Design Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, verify, manufacture and deploy semiconductor and embedded-system capabilities."
    },
    {
     "title": "Physical Design Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, verify, manufacture and deploy semiconductor and embedded-system capabilities."
    },
    {
     "title": "RTL Design Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, verify, manufacture and deploy semiconductor and embedded-system capabilities."
    },
    {
     "title": "Verification Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, verify, manufacture and deploy semiconductor and embedded-system capabilities."
    },
    {
     "title": "DFT Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, verify, manufacture and deploy semiconductor and embedded-system capabilities."
    },
    {
     "title": "Analog / Mixed-Signal Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, verify, manufacture and deploy semiconductor and embedded-system capabilities."
    },
    {
     "title": "Semiconductor Process Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, verify, manufacture and deploy semiconductor and embedded-system capabilities."
    },
    {
     "title": "Semiconductor Product Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, verify, manufacture and deploy semiconductor and embedded-system capabilities."
    },
    {
     "title": "Embedded Systems Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, verify, manufacture and deploy semiconductor and embedded-system capabilities."
    },
    {
     "title": "Firmware Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, verify, manufacture and deploy semiconductor and embedded-system capabilities."
    },
    {
     "title": "FPGA Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, verify, manufacture and deploy semiconductor and embedded-system capabilities."
    },
    {
     "title": "Hardware Validation Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, verify, manufacture and deploy semiconductor and embedded-system capabilities."
    },
    {
     "title": "Packaging Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, verify, manufacture and deploy semiconductor and embedded-system capabilities."
    },
    {
     "title": "Technical Deployment Lead - Semiconductors",
     "aliases": [],
     "family": "Forward Deployed / Deployment Engineering",
     "marketSignal": "High-growth / expanding",
     "purpose": ""
    }
   ]
  },
  {
   "order": 9,
   "name": "Robotics, Autonomous Systems & Industrial Automation",
   "summary": "Create safe autonomous and automated systems that sense, decide and act in the physical world.",
   "roles": [
    {
     "title": "Robotics Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create safe autonomous and automated systems that sense, decide and act in the physical world."
    },
    {
     "title": "Robotics Software Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create safe autonomous and automated systems that sense, decide and act in the physical world."
    },
    {
     "title": "Controls Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create safe autonomous and automated systems that sense, decide and act in the physical world."
    },
    {
     "title": "Automation Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create safe autonomous and automated systems that sense, decide and act in the physical world."
    },
    {
     "title": "Mechatronics Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create safe autonomous and automated systems that sense, decide and act in the physical world."
    },
    {
     "title": "Autonomous Systems Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create safe autonomous and automated systems that sense, decide and act in the physical world."
    },
    {
     "title": "Computer Vision Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create safe autonomous and automated systems that sense, decide and act in the physical world."
    },
    {
     "title": "SLAM Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create safe autonomous and automated systems that sense, decide and act in the physical world."
    },
    {
     "title": "Motion Planning Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create safe autonomous and automated systems that sense, decide and act in the physical world."
    },
    {
     "title": "Industrial Controls Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create safe autonomous and automated systems that sense, decide and act in the physical world."
    },
    {
     "title": "PLC Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create safe autonomous and automated systems that sense, decide and act in the physical world."
    },
    {
     "title": "Edge AI Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Emerging / rapidly formalising",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create safe autonomous and automated systems that sense, decide and act in the physical world."
    },
    {
     "title": "Digital Twin Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Emerging / rapidly formalising",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create safe autonomous and automated systems that sense, decide and act in the physical world."
    },
    {
     "title": "Robot Operations Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create safe autonomous and automated systems that sense, decide and act in the physical world."
    }
   ]
  },
  {
   "order": 10,
   "name": "BFSI, FinTech, Payments, Risk & Insurance",
   "summary": "Build and manage financial products, models, controls and risk decisions in regulated environments.",
   "roles": [
    {
     "title": "FinTech Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to build and manage financial products, models, controls and risk decisions in regulated environments."
    },
    {
     "title": "Payments Product Manager",
     "aliases": [],
     "family": "Product Management",
     "marketSignal": "Established / evolving",
     "purpose": "Own product outcomes, prioritization and cross-functional delivery so the organisation can build and manage financial products, models, controls and risk decisions in regulated environments."
    },
    {
     "title": "Digital Banking Product Manager",
     "aliases": [],
     "family": "Product Management",
     "marketSignal": "Established / evolving",
     "purpose": "Own product outcomes, prioritization and cross-functional delivery so the organisation can build and manage financial products, models, controls and risk decisions in regulated environments."
    },
    {
     "title": "Quantitative Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation build and manage financial products, models, controls and risk decisions in regulated environments."
    },
    {
     "title": "Quantitative Developer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to build and manage financial products, models, controls and risk decisions in regulated environments."
    },
    {
     "title": "Actuary",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation build and manage financial products, models, controls and risk decisions in regulated environments."
    },
    {
     "title": "Credit Risk Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "High-growth / expanding",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation build and manage financial products, models, controls and risk decisions in regulated environments."
    },
    {
     "title": "Market Risk Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "High-growth / expanding",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation build and manage financial products, models, controls and risk decisions in regulated environments."
    },
    {
     "title": "Model Risk Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can build and manage financial products, models, controls and risk decisions in regulated environments."
    },
    {
     "title": "Fraud & Financial Crime Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation build and manage financial products, models, controls and risk decisions in regulated environments."
    },
    {
     "title": "AML / KYC Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can build and manage financial products, models, controls and risk decisions in regulated environments."
    },
    {
     "title": "Treasury Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation build and manage financial products, models, controls and risk decisions in regulated environments."
    },
    {
     "title": "Risk Management Consultant",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "High-growth / expanding",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can build and manage financial products, models, controls and risk decisions in regulated environments."
    },
    {
     "title": "Insurance Product Manager",
     "aliases": [],
     "family": "Product Management",
     "marketSignal": "Established / evolving",
     "purpose": "Own product outcomes, prioritization and cross-functional delivery so the organisation can build and manage financial products, models, controls and risk decisions in regulated environments."
    }
   ]
  },
  {
   "order": 11,
   "name": "Healthcare, Clinical & HealthTech",
   "summary": "Improve clinical and operational outcomes while protecting patient safety, privacy and compliance.",
   "roles": [
    {
     "title": "Registered Nurse",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Nurse Practitioner / Advanced Practice Nurse",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Physician Assistant / Associate",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Medical & Health Services Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can improve clinical and operational outcomes while protecting patient safety, privacy and compliance."
    },
    {
     "title": "Clinical Informatics Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can improve clinical and operational outcomes while protecting patient safety, privacy and compliance."
    },
    {
     "title": "Clinical Data Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can improve clinical and operational outcomes while protecting patient safety, privacy and compliance."
    },
    {
     "title": "Health Data Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "High-growth / expanding",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation improve clinical and operational outcomes while protecting patient safety, privacy and compliance."
    },
    {
     "title": "Digital Health Product Manager",
     "aliases": [],
     "family": "Product Management",
     "marketSignal": "High-growth / expanding",
     "purpose": "Own product outcomes, prioritization and cross-functional delivery so the organisation can improve clinical and operational outcomes while protecting patient safety, privacy and compliance."
    },
    {
     "title": "Medical AI Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "High-growth / expanding",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can improve clinical and operational outcomes while protecting patient safety, privacy and compliance."
    },
    {
     "title": "Clinical Research Associate",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Clinical Operations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can improve clinical and operational outcomes while protecting patient safety, privacy and compliance."
    },
    {
     "title": "Healthcare Solutions Architect",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to improve clinical and operational outcomes while protecting patient safety, privacy and compliance."
    },
    {
     "title": "Telehealth Program Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can improve clinical and operational outcomes while protecting patient safety, privacy and compliance."
    },
    {
     "title": "Population Health Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "High-growth / expanding",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation improve clinical and operational outcomes while protecting patient safety, privacy and compliance."
    }
   ]
  },
  {
   "order": 12,
   "name": "Life Sciences, Biotech, Pharma & Bioinformatics",
   "summary": "Advance research, development and regulated delivery of life-science and pharmaceutical products.",
   "roles": [
    {
     "title": "Bioinformatics Scientist",
     "aliases": [],
     "family": "Research & Applied Science",
     "marketSignal": "High-growth / expanding",
     "purpose": ""
    },
    {
     "title": "Computational Biologist",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "High-growth / expanding",
     "purpose": ""
    },
    {
     "title": "Biostatistician",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "High-growth / expanding",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation advance research, development and regulated delivery of life-science and pharmaceutical products."
    },
    {
     "title": "Clinical Scientist",
     "aliases": [],
     "family": "Research & Applied Science",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Research Scientist - Biotech",
     "aliases": [],
     "family": "Research & Applied Science",
     "marketSignal": "High-growth / expanding",
     "purpose": ""
    },
    {
     "title": "Process Development Scientist",
     "aliases": [],
     "family": "Research & Applied Science",
     "marketSignal": "High-growth / expanding",
     "purpose": ""
    },
    {
     "title": "Bioprocess Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to advance research, development and regulated delivery of life-science and pharmaceutical products."
    },
    {
     "title": "Regulatory Affairs Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "High-growth / expanding",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can advance research, development and regulated delivery of life-science and pharmaceutical products."
    },
    {
     "title": "Pharmacovigilance Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can advance research, development and regulated delivery of life-science and pharmaceutical products."
    },
    {
     "title": "Medical Affairs Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can advance research, development and regulated delivery of life-science and pharmaceutical products."
    },
    {
     "title": "Drug Safety Scientist",
     "aliases": [],
     "family": "Research & Applied Science",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Clinical Trial Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can advance research, development and regulated delivery of life-science and pharmaceutical products."
    },
    {
     "title": "Quality Assurance - GxP Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can advance research, development and regulated delivery of life-science and pharmaceutical products."
    },
    {
     "title": "Lab Automation Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to advance research, development and regulated delivery of life-science and pharmaceutical products."
    }
   ]
  },
  {
   "order": 13,
   "name": "Sustainability, Climate, ESG & Renewable Energy",
   "summary": "Reduce environmental impact and accelerate climate, energy and sustainability outcomes.",
   "roles": [
    {
     "title": "Sustainability Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can reduce environmental impact and accelerate climate, energy and sustainability outcomes."
    },
    {
     "title": "Sustainability Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "High-growth / expanding",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation reduce environmental impact and accelerate climate, energy and sustainability outcomes."
    },
    {
     "title": "ESG Reporting Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can reduce environmental impact and accelerate climate, energy and sustainability outcomes."
    },
    {
     "title": "Carbon Accounting Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can reduce environmental impact and accelerate climate, energy and sustainability outcomes."
    },
    {
     "title": "Climate Risk Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "High-growth / expanding",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation reduce environmental impact and accelerate climate, energy and sustainability outcomes."
    },
    {
     "title": "Environmental Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to reduce environmental impact and accelerate climate, energy and sustainability outcomes."
    },
    {
     "title": "Renewable Energy Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to reduce environmental impact and accelerate climate, energy and sustainability outcomes."
    },
    {
     "title": "Solar PV Design Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to reduce environmental impact and accelerate climate, energy and sustainability outcomes."
    },
    {
     "title": "Solar Consultant",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can reduce environmental impact and accelerate climate, energy and sustainability outcomes."
    },
    {
     "title": "Wind Energy Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to reduce environmental impact and accelerate climate, energy and sustainability outcomes."
    },
    {
     "title": "Wind Turbine Service Technician",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to reduce environmental impact and accelerate climate, energy and sustainability outcomes."
    },
    {
     "title": "Energy Storage Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to reduce environmental impact and accelerate climate, energy and sustainability outcomes."
    },
    {
     "title": "Circular Economy Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can reduce environmental impact and accelerate climate, energy and sustainability outcomes."
    },
    {
     "title": "Decarbonization Program Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can reduce environmental impact and accelerate climate, energy and sustainability outcomes."
    }
   ]
  },
  {
   "order": 14,
   "name": "Energy, Utilities, Power & Oil and Gas",
   "summary": "Design and operate reliable energy systems while balancing safety, economics, resilience and transition goals.",
   "roles": [
    {
     "title": "Power Systems Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design and operate reliable energy systems while balancing safety, economics, resilience and transition goals."
    },
    {
     "title": "Grid Modernization Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design and operate reliable energy systems while balancing safety, economics, resilience and transition goals."
    },
    {
     "title": "Protection & Control Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design and operate reliable energy systems while balancing safety, economics, resilience and transition goals."
    },
    {
     "title": "Electrical Utility Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design and operate reliable energy systems while balancing safety, economics, resilience and transition goals."
    },
    {
     "title": "Energy Market Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation design and operate reliable energy systems while balancing safety, economics, resilience and transition goals."
    },
    {
     "title": "Energy Trading Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation design and operate reliable energy systems while balancing safety, economics, resilience and transition goals."
    },
    {
     "title": "Battery Storage Project Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design and operate reliable energy systems while balancing safety, economics, resilience and transition goals."
    },
    {
     "title": "Petroleum Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design and operate reliable energy systems while balancing safety, economics, resilience and transition goals."
    },
    {
     "title": "Process Engineer - Oil & Gas",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design and operate reliable energy systems while balancing safety, economics, resilience and transition goals."
    },
    {
     "title": "Pipeline Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design and operate reliable energy systems while balancing safety, economics, resilience and transition goals."
    },
    {
     "title": "Utility Operations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can design and operate reliable energy systems while balancing safety, economics, resilience and transition goals."
    },
    {
     "title": "Reliability Engineer - Energy",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design and operate reliable energy systems while balancing safety, economics, resilience and transition goals."
    },
    {
     "title": "Hydrogen Project Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design and operate reliable energy systems while balancing safety, economics, resilience and transition goals."
    },
    {
     "title": "Energy Transition Strategy Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can design and operate reliable energy systems while balancing safety, economics, resilience and transition goals."
    }
   ]
  },
  {
   "order": 15,
   "name": "Manufacturing, Quality & Industry 4.0",
   "summary": "Improve safety, quality, throughput, reliability and cost across physical production systems.",
   "roles": [
    {
     "title": "Manufacturing Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to improve safety, quality, throughput, reliability and cost across physical production systems."
    },
    {
     "title": "Industrial Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to improve safety, quality, throughput, reliability and cost across physical production systems."
    },
    {
     "title": "Manufacturing Quality Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can improve safety, quality, throughput, reliability and cost across physical production systems."
    },
    {
     "title": "Quality Systems Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to improve safety, quality, throughput, reliability and cost across physical production systems."
    },
    {
     "title": "Supplier Quality Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to improve safety, quality, throughput, reliability and cost across physical production systems."
    },
    {
     "title": "Process Engineer - Manufacturing",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to improve safety, quality, throughput, reliability and cost across physical production systems."
    },
    {
     "title": "Lean / Continuous Improvement Lead",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can improve safety, quality, throughput, reliability and cost across physical production systems."
    },
    {
     "title": "Smart Factory Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to improve safety, quality, throughput, reliability and cost across physical production systems."
    },
    {
     "title": "MES Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to improve safety, quality, throughput, reliability and cost across physical production systems."
    },
    {
     "title": "Industrial IoT Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to improve safety, quality, throughput, reliability and cost across physical production systems."
    },
    {
     "title": "Production Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can improve safety, quality, throughput, reliability and cost across physical production systems."
    },
    {
     "title": "Maintenance & Reliability Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can improve safety, quality, throughput, reliability and cost across physical production systems."
    },
    {
     "title": "Operational Excellence Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can improve safety, quality, throughput, reliability and cost across physical production systems."
    },
    {
     "title": "Factory Data Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "High-growth / expanding",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation improve safety, quality, throughput, reliability and cost across physical production systems."
    }
   ]
  },
  {
   "order": 16,
   "name": "Supply Chain, Procurement, Logistics & Mobility",
   "summary": "Plan and execute resilient, cost-effective movement of materials, inventory and services.",
   "roles": [
    {
     "title": "Supply Chain Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "High-growth / expanding",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation plan and execute resilient, cost-effective movement of materials, inventory and services."
    },
    {
     "title": "Supply Planner",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Demand Planner",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "S&OP / IBP Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can plan and execute resilient, cost-effective movement of materials, inventory and services."
    },
    {
     "title": "Procurement Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can plan and execute resilient, cost-effective movement of materials, inventory and services."
    },
    {
     "title": "Strategic Sourcing Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can plan and execute resilient, cost-effective movement of materials, inventory and services."
    },
    {
     "title": "Category Manager - Procurement",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can plan and execute resilient, cost-effective movement of materials, inventory and services."
    },
    {
     "title": "Logistics Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can plan and execute resilient, cost-effective movement of materials, inventory and services."
    },
    {
     "title": "Transportation Planner",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Warehouse Operations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can plan and execute resilient, cost-effective movement of materials, inventory and services."
    },
    {
     "title": "Inventory Optimization Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation plan and execute resilient, cost-effective movement of materials, inventory and services."
    },
    {
     "title": "Global Trade Compliance Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can plan and execute resilient, cost-effective movement of materials, inventory and services."
    },
    {
     "title": "Last-Mile Operations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can plan and execute resilient, cost-effective movement of materials, inventory and services."
    },
    {
     "title": "Supply Chain Digital Transformation Lead",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can plan and execute resilient, cost-effective movement of materials, inventory and services."
    }
   ]
  },
  {
   "order": 17,
   "name": "Sales, Solutions, GTM & Revenue Operations",
   "summary": "Create predictable revenue by developing opportunities, shaping solutions and improving gtm execution.",
   "roles": [
    {
     "title": "Enterprise Account Executive",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Account Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create predictable revenue by developing opportunities, shaping solutions and improving GTM execution."
    },
    {
     "title": "Sales Development Representative",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "High-growth / expanding",
     "purpose": ""
    },
    {
     "title": "Business Development Representative",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "High-growth / expanding",
     "purpose": ""
    },
    {
     "title": "Director of Business Development",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create predictable revenue by developing opportunities, shaping solutions and improving GTM execution."
    },
    {
     "title": "Solutions Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create predictable revenue by developing opportunities, shaping solutions and improving GTM execution."
    },
    {
     "title": "Solutions Consultant",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can create predictable revenue by developing opportunities, shaping solutions and improving GTM execution."
    },
    {
     "title": "Sales Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create predictable revenue by developing opportunities, shaping solutions and improving GTM execution."
    },
    {
     "title": "Revenue Operations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create predictable revenue by developing opportunities, shaping solutions and improving GTM execution."
    },
    {
     "title": "Sales Operations Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation create predictable revenue by developing opportunities, shaping solutions and improving GTM execution."
    },
    {
     "title": "Sales Enablement Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create predictable revenue by developing opportunities, shaping solutions and improving GTM execution."
    },
    {
     "title": "Commercial Advisor",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can create predictable revenue by developing opportunities, shaping solutions and improving GTM execution."
    },
    {
     "title": "Deal Desk Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create predictable revenue by developing opportunities, shaping solutions and improving GTM execution."
    },
    {
     "title": "GTM Strategy & Operations Lead",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create predictable revenue by developing opportunities, shaping solutions and improving GTM execution."
    }
   ]
  },
  {
   "order": 18,
   "name": "Customer Success, Services & Partnerships",
   "summary": "Drive customer adoption, outcomes, retention, implementation success and partner leverage.",
   "roles": [
    {
     "title": "Customer Success Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can drive customer adoption, outcomes, retention, implementation success and partner leverage."
    },
    {
     "title": "Technical Account Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can drive customer adoption, outcomes, retention, implementation success and partner leverage."
    },
    {
     "title": "Customer Success Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to drive customer adoption, outcomes, retention, implementation success and partner leverage."
    },
    {
     "title": "Professional Services Consultant",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can drive customer adoption, outcomes, retention, implementation success and partner leverage."
    },
    {
     "title": "Implementation Consultant",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can drive customer adoption, outcomes, retention, implementation success and partner leverage."
    },
    {
     "title": "Implementation Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to drive customer adoption, outcomes, retention, implementation success and partner leverage."
    },
    {
     "title": "Customer Support Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to drive customer adoption, outcomes, retention, implementation success and partner leverage."
    },
    {
     "title": "Partner Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can drive customer adoption, outcomes, retention, implementation success and partner leverage."
    },
    {
     "title": "Strategic Partnerships Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can drive customer adoption, outcomes, retention, implementation success and partner leverage."
    },
    {
     "title": "Channel Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can drive customer adoption, outcomes, retention, implementation success and partner leverage."
    },
    {
     "title": "Alliance Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can drive customer adoption, outcomes, retention, implementation success and partner leverage."
    },
    {
     "title": "Customer Experience Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can drive customer adoption, outcomes, retention, implementation success and partner leverage."
    },
    {
     "title": "Service Delivery Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can drive customer adoption, outcomes, retention, implementation success and partner leverage."
    },
    {
     "title": "Renewals Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can drive customer adoption, outcomes, retention, implementation success and partner leverage."
    }
   ]
  },
  {
   "order": 19,
   "name": "Marketing, Brand, Growth & Communications",
   "summary": "Create demand, strengthen positioning and improve acquisition, engagement and lifetime value.",
   "roles": [
    {
     "title": "Product Marketing Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create demand, strengthen positioning and improve acquisition, engagement and lifetime value."
    },
    {
     "title": "Growth Marketing Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create demand, strengthen positioning and improve acquisition, engagement and lifetime value."
    },
    {
     "title": "Performance Marketing Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can create demand, strengthen positioning and improve acquisition, engagement and lifetime value."
    },
    {
     "title": "Brand Strategist",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Brand Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create demand, strengthen positioning and improve acquisition, engagement and lifetime value."
    },
    {
     "title": "Content Strategist",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Lifecycle / CRM Marketing Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create demand, strengthen positioning and improve acquisition, engagement and lifetime value."
    },
    {
     "title": "Marketing Operations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create demand, strengthen positioning and improve acquisition, engagement and lifetime value."
    },
    {
     "title": "Marketing Data Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "High-growth / expanding",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation create demand, strengthen positioning and improve acquisition, engagement and lifetime value."
    },
    {
     "title": "SEO / Organic Growth Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can create demand, strengthen positioning and improve acquisition, engagement and lifetime value."
    },
    {
     "title": "Media Buyer",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Communications Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create demand, strengthen positioning and improve acquisition, engagement and lifetime value."
    },
    {
     "title": "PR Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create demand, strengthen positioning and improve acquisition, engagement and lifetime value."
    },
    {
     "title": "Community Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create demand, strengthen positioning and improve acquisition, engagement and lifetime value."
    }
   ]
  },
  {
   "order": 20,
   "name": "Human Resources, Talent, People Analytics & Learning",
   "summary": "Build the workforce, leadership capability and people systems required for business strategy.",
   "roles": [
    {
     "title": "HR Business Partner",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Human Resources Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can build the workforce, leadership capability and people systems required for business strategy."
    },
    {
     "title": "Talent Acquisition Partner",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Executive Recruiter",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "People Analytics Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "High-growth / expanding",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can build the workforce, leadership capability and people systems required for business strategy."
    },
    {
     "title": "Workforce Planning Lead",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can build the workforce, leadership capability and people systems required for business strategy."
    },
    {
     "title": "Compensation & Benefits Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can build the workforce, leadership capability and people systems required for business strategy."
    },
    {
     "title": "Total Rewards Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can build the workforce, leadership capability and people systems required for business strategy."
    },
    {
     "title": "Learning & Development Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can build the workforce, leadership capability and people systems required for business strategy."
    },
    {
     "title": "Instructional Designer - Corporate Learning",
     "aliases": [],
     "family": "Design / Creative / Production",
     "marketSignal": "Established / evolving",
     "purpose": "Research, design and deliver experiences or creative outputs that help the organisation build the workforce, leadership capability and people systems required for business strategy."
    },
    {
     "title": "Organizational Development Consultant",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "High-growth / expanding",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can build the workforce, leadership capability and people systems required for business strategy."
    },
    {
     "title": "Employee Experience Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can build the workforce, leadership capability and people systems required for business strategy."
    },
    {
     "title": "HRIS Product Manager",
     "aliases": [],
     "family": "Product Management",
     "marketSignal": "Established / evolving",
     "purpose": "Own product outcomes, prioritization and cross-functional delivery so the organisation can build the workforce, leadership capability and people systems required for business strategy."
    },
    {
     "title": "AI Talent & Skills Transformation Lead",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Emerging / rapidly formalising",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can build the workforce, leadership capability and people systems required for business strategy."
    }
   ]
  },
  {
   "order": 21,
   "name": "Strategy, Consulting, Transformation & Business Operations",
   "summary": "Translate complex business problems into strategic choices, operating models and measurable transformation.",
   "roles": [
    {
     "title": "Management Consultant",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can translate complex business problems into strategic choices, operating models and measurable transformation."
    },
    {
     "title": "Strategy Consultant",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can translate complex business problems into strategic choices, operating models and measurable transformation."
    },
    {
     "title": "Strategy Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can translate complex business problems into strategic choices, operating models and measurable transformation."
    },
    {
     "title": "Strategic Advisor",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can translate complex business problems into strategic choices, operating models and measurable transformation."
    },
    {
     "title": "Business Operations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can translate complex business problems into strategic choices, operating models and measurable transformation."
    },
    {
     "title": "Transformation Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can translate complex business problems into strategic choices, operating models and measurable transformation."
    },
    {
     "title": "AI Transformation Lead",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Emerging / rapidly formalising",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can translate complex business problems into strategic choices, operating models and measurable transformation."
    },
    {
     "title": "Chief of Staff",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can translate complex business problems into strategic choices, operating models and measurable transformation."
    },
    {
     "title": "Program Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can translate complex business problems into strategic choices, operating models and measurable transformation."
    },
    {
     "title": "Portfolio Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can translate complex business problems into strategic choices, operating models and measurable transformation."
    },
    {
     "title": "PMO Lead",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can translate complex business problems into strategic choices, operating models and measurable transformation."
    },
    {
     "title": "Business Process Excellence Lead",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can translate complex business problems into strategic choices, operating models and measurable transformation."
    },
    {
     "title": "Operating Model Consultant",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can translate complex business problems into strategic choices, operating models and measurable transformation."
    },
    {
     "title": "Corporate Development Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can translate complex business problems into strategic choices, operating models and measurable transformation."
    }
   ]
  },
  {
   "order": 22,
   "name": "Finance, Accounting, FP&A & Corporate Treasury",
   "summary": "Provide financial stewardship, planning, reporting, controls and capital decision support.",
   "roles": [
    {
     "title": "Financial Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation provide financial stewardship, planning, reporting, controls and capital decision support."
    },
    {
     "title": "FP&A Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation provide financial stewardship, planning, reporting, controls and capital decision support."
    },
    {
     "title": "FP&A Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can provide financial stewardship, planning, reporting, controls and capital decision support."
    },
    {
     "title": "Management Accountant",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Financial Controller",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can provide financial stewardship, planning, reporting, controls and capital decision support."
    },
    {
     "title": "Corporate Treasurer",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can provide financial stewardship, planning, reporting, controls and capital decision support."
    },
    {
     "title": "Treasury Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can provide financial stewardship, planning, reporting, controls and capital decision support."
    },
    {
     "title": "Investor Relations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can provide financial stewardship, planning, reporting, controls and capital decision support."
    },
    {
     "title": "Finance Business Partner",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Tax Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can provide financial stewardship, planning, reporting, controls and capital decision support."
    },
    {
     "title": "Internal Audit Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can provide financial stewardship, planning, reporting, controls and capital decision support."
    },
    {
     "title": "Forensic Accountant",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Finance Systems Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can provide financial stewardship, planning, reporting, controls and capital decision support."
    },
    {
     "title": "Strategic Finance Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can provide financial stewardship, planning, reporting, controls and capital decision support."
    }
   ]
  },
  {
   "order": 23,
   "name": "Legal, Compliance, Governance & Regulatory",
   "summary": "Enable business within legal and regulatory boundaries while managing contractual and governance risk.",
   "roles": [
    {
     "title": "Corporate Counsel",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can enable business within legal and regulatory boundaries while managing contractual and governance risk."
    },
    {
     "title": "Commercial Counsel",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can enable business within legal and regulatory boundaries while managing contractual and governance risk."
    },
    {
     "title": "Technology Counsel",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can enable business within legal and regulatory boundaries while managing contractual and governance risk."
    },
    {
     "title": "Privacy Counsel",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can enable business within legal and regulatory boundaries while managing contractual and governance risk."
    },
    {
     "title": "Legal Operations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can enable business within legal and regulatory boundaries while managing contractual and governance risk."
    },
    {
     "title": "Contract Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can enable business within legal and regulatory boundaries while managing contractual and governance risk."
    },
    {
     "title": "Compliance Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can enable business within legal and regulatory boundaries while managing contractual and governance risk."
    },
    {
     "title": "Regulatory Affairs Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can enable business within legal and regulatory boundaries while managing contractual and governance risk."
    },
    {
     "title": "Data Protection Officer",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "High-growth / expanding",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can enable business within legal and regulatory boundaries while managing contractual and governance risk."
    },
    {
     "title": "AI Governance Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Emerging / rapidly formalising",
     "purpose": "Create and operate governance systems that make AI use accountable, traceable, compliant and proportionate to risk across the model and application lifecycle."
    },
    {
     "title": "Technology Risk & Compliance Lead",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can enable business within legal and regulatory boundaries while managing contractual and governance risk."
    },
    {
     "title": "Policy Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation enable business within legal and regulatory boundaries while managing contractual and governance risk."
    },
    {
     "title": "Regulatory Intelligence Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation enable business within legal and regulatory boundaries while managing contractual and governance risk."
    },
    {
     "title": "Ethics & Compliance Officer",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can enable business within legal and regulatory boundaries while managing contractual and governance risk."
    }
   ]
  },
  {
   "order": 24,
   "name": "Construction, Real Estate, Urban & Infrastructure",
   "summary": "Plan, design, deliver and optimize buildings, infrastructure and real-estate assets.",
   "roles": [
    {
     "title": "Construction Project Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can plan, design, deliver and optimize buildings, infrastructure and real-estate assets."
    },
    {
     "title": "Civil Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to plan, design, deliver and optimize buildings, infrastructure and real-estate assets."
    },
    {
     "title": "Structural Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to plan, design, deliver and optimize buildings, infrastructure and real-estate assets."
    },
    {
     "title": "Quantity Surveyor / Cost Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can plan, design, deliver and optimize buildings, infrastructure and real-estate assets."
    },
    {
     "title": "BIM Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can plan, design, deliver and optimize buildings, infrastructure and real-estate assets."
    },
    {
     "title": "BIM Technician",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to plan, design, deliver and optimize buildings, infrastructure and real-estate assets."
    },
    {
     "title": "Urban Designer",
     "aliases": [],
     "family": "Design / Creative / Production",
     "marketSignal": "Established / evolving",
     "purpose": "Research, design and deliver experiences or creative outputs that help the organisation plan, design, deliver and optimize buildings, infrastructure and real-estate assets."
    },
    {
     "title": "Urban Planner",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Infrastructure Planning Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can plan, design, deliver and optimize buildings, infrastructure and real-estate assets."
    },
    {
     "title": "Smart Cities Consultant",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can plan, design, deliver and optimize buildings, infrastructure and real-estate assets."
    },
    {
     "title": "Geospatial / GIS Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation plan, design, deliver and optimize buildings, infrastructure and real-estate assets."
    },
    {
     "title": "Real Estate Asset Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can plan, design, deliver and optimize buildings, infrastructure and real-estate assets."
    },
    {
     "title": "Facilities Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can plan, design, deliver and optimize buildings, infrastructure and real-estate assets."
    },
    {
     "title": "Sustainable Building Consultant",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "High-growth / expanding",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can plan, design, deliver and optimize buildings, infrastructure and real-estate assets."
    }
   ]
  },
  {
   "order": 25,
   "name": "Aerospace, Aviation, Space & Defence",
   "summary": "Design, validate, operate and sustain safety-critical aerospace, space and mission systems.",
   "roles": [
    {
     "title": "Aerospace Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, validate, operate and sustain safety-critical aerospace, space and mission systems."
    },
    {
     "title": "Avionics Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, validate, operate and sustain safety-critical aerospace, space and mission systems."
    },
    {
     "title": "Flight Systems Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, validate, operate and sustain safety-critical aerospace, space and mission systems."
    },
    {
     "title": "Aircraft Maintenance Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, validate, operate and sustain safety-critical aerospace, space and mission systems."
    },
    {
     "title": "Aviation Safety Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can design, validate, operate and sustain safety-critical aerospace, space and mission systems."
    },
    {
     "title": "Space Systems Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, validate, operate and sustain safety-critical aerospace, space and mission systems."
    },
    {
     "title": "Satellite Systems Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, validate, operate and sustain safety-critical aerospace, space and mission systems."
    },
    {
     "title": "Mission Systems Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, validate, operate and sustain safety-critical aerospace, space and mission systems."
    },
    {
     "title": "Ground Systems Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, validate, operate and sustain safety-critical aerospace, space and mission systems."
    },
    {
     "title": "Drone / UAS Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, validate, operate and sustain safety-critical aerospace, space and mission systems."
    },
    {
     "title": "Defence Systems Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, validate, operate and sustain safety-critical aerospace, space and mission systems."
    },
    {
     "title": "Systems Safety Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, validate, operate and sustain safety-critical aerospace, space and mission systems."
    },
    {
     "title": "Flight Test Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, validate, operate and sustain safety-critical aerospace, space and mission systems."
    },
    {
     "title": "Space Mission Operations Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design, validate, operate and sustain safety-critical aerospace, space and mission systems."
    }
   ]
  },
  {
   "order": 26,
   "name": "Automotive, EV & Mobility Technology",
   "summary": "Develop safe, software-defined, electrified and connected mobility systems.",
   "roles": [
    {
     "title": "Automotive Systems Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to develop safe, software-defined, electrified and connected mobility systems."
    },
    {
     "title": "Electric Vehicle Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to develop safe, software-defined, electrified and connected mobility systems."
    },
    {
     "title": "Battery Systems Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to develop safe, software-defined, electrified and connected mobility systems."
    },
    {
     "title": "Battery Management Systems Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to develop safe, software-defined, electrified and connected mobility systems."
    },
    {
     "title": "Power Electronics Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to develop safe, software-defined, electrified and connected mobility systems."
    },
    {
     "title": "ADAS Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to develop safe, software-defined, electrified and connected mobility systems."
    },
    {
     "title": "Vehicle Software Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to develop safe, software-defined, electrified and connected mobility systems."
    },
    {
     "title": "Automotive Cybersecurity Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to develop safe, software-defined, electrified and connected mobility systems."
    },
    {
     "title": "Functional Safety Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to develop safe, software-defined, electrified and connected mobility systems."
    },
    {
     "title": "Automotive Validation Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to develop safe, software-defined, electrified and connected mobility systems."
    },
    {
     "title": "Charging Infrastructure Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to develop safe, software-defined, electrified and connected mobility systems."
    },
    {
     "title": "Connected Vehicle Product Manager",
     "aliases": [],
     "family": "Product Management",
     "marketSignal": "Established / evolving",
     "purpose": "Own product outcomes, prioritization and cross-functional delivery so the organisation can develop safe, software-defined, electrified and connected mobility systems."
    },
    {
     "title": "Mobility Product Manager",
     "aliases": [],
     "family": "Product Management",
     "marketSignal": "Established / evolving",
     "purpose": "Own product outcomes, prioritization and cross-functional delivery so the organisation can develop safe, software-defined, electrified and connected mobility systems."
    },
    {
     "title": "Autonomous Vehicle Safety Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Emerging / rapidly formalising",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to develop safe, software-defined, electrified and connected mobility systems."
    }
   ]
  },
  {
   "order": 27,
   "name": "Agriculture, Food Systems & AgriTech",
   "summary": "Increase food-system productivity, resilience, safety and sustainability through science, operations and technology.",
   "roles": [
    {
     "title": "Agronomist",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Agricultural Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to increase food-system productivity, resilience, safety and sustainability through science, operations and technology."
    },
    {
     "title": "Precision Agriculture Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can increase food-system productivity, resilience, safety and sustainability through science, operations and technology."
    },
    {
     "title": "Farm Operations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can increase food-system productivity, resilience, safety and sustainability through science, operations and technology."
    },
    {
     "title": "Agricultural Data Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "High-growth / expanding",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation increase food-system productivity, resilience, safety and sustainability through science, operations and technology."
    },
    {
     "title": "AgriTech Product Manager",
     "aliases": [],
     "family": "Product Management",
     "marketSignal": "Established / evolving",
     "purpose": "Own product outcomes, prioritization and cross-functional delivery so the organisation can increase food-system productivity, resilience, safety and sustainability through science, operations and technology."
    },
    {
     "title": "Food Technologist",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Food Safety & Quality Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can increase food-system productivity, resilience, safety and sustainability through science, operations and technology."
    },
    {
     "title": "Food Processing Operations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can increase food-system productivity, resilience, safety and sustainability through science, operations and technology."
    },
    {
     "title": "Aquaculture Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can increase food-system productivity, resilience, safety and sustainability through science, operations and technology."
    },
    {
     "title": "Supply Chain Specialist - Food",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "High-growth / expanding",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can increase food-system productivity, resilience, safety and sustainability through science, operations and technology."
    },
    {
     "title": "Agricultural Sustainability Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "High-growth / expanding",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can increase food-system productivity, resilience, safety and sustainability through science, operations and technology."
    },
    {
     "title": "Remote Sensing Analyst - Agriculture",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation increase food-system productivity, resilience, safety and sustainability through science, operations and technology."
    },
    {
     "title": "Controlled Environment Agriculture Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can increase food-system productivity, resilience, safety and sustainability through science, operations and technology."
    }
   ]
  },
  {
   "order": 28,
   "name": "Retail, E-commerce & Consumer",
   "summary": "Grow profitable consumer businesses through commerce, merchandising, pricing and omnichannel execution.",
   "roles": [
    {
     "title": "E-commerce Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can grow profitable consumer businesses through commerce, merchandising, pricing and omnichannel execution."
    },
    {
     "title": "Marketplace Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can grow profitable consumer businesses through commerce, merchandising, pricing and omnichannel execution."
    },
    {
     "title": "Retail Operations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can grow profitable consumer businesses through commerce, merchandising, pricing and omnichannel execution."
    },
    {
     "title": "Merchandising Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can grow profitable consumer businesses through commerce, merchandising, pricing and omnichannel execution."
    },
    {
     "title": "Category Manager - Retail",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can grow profitable consumer businesses through commerce, merchandising, pricing and omnichannel execution."
    },
    {
     "title": "Digital Commerce Product Manager",
     "aliases": [],
     "family": "Product Management",
     "marketSignal": "Established / evolving",
     "purpose": "Own product outcomes, prioritization and cross-functional delivery so the organisation can grow profitable consumer businesses through commerce, merchandising, pricing and omnichannel execution."
    },
    {
     "title": "Retail Data Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "High-growth / expanding",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation grow profitable consumer businesses through commerce, merchandising, pricing and omnichannel execution."
    },
    {
     "title": "Omnichannel Experience Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can grow profitable consumer businesses through commerce, merchandising, pricing and omnichannel execution."
    },
    {
     "title": "Pricing Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation grow profitable consumer businesses through commerce, merchandising, pricing and omnichannel execution."
    },
    {
     "title": "Revenue Management Analyst - Consumer",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "High-growth / expanding",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation grow profitable consumer businesses through commerce, merchandising, pricing and omnichannel execution."
    },
    {
     "title": "Store Operations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can grow profitable consumer businesses through commerce, merchandising, pricing and omnichannel execution."
    },
    {
     "title": "Customer Loyalty Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can grow profitable consumer businesses through commerce, merchandising, pricing and omnichannel execution."
    },
    {
     "title": "Retail Media Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Emerging / rapidly formalising",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can grow profitable consumer businesses through commerce, merchandising, pricing and omnichannel execution."
    },
    {
     "title": "Consumer Insights Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can grow profitable consumer businesses through commerce, merchandising, pricing and omnichannel execution."
    }
   ]
  },
  {
   "order": 29,
   "name": "Travel, Hospitality, Food Service & Events",
   "summary": "Design and operate high-quality travel, hospitality and event experiences profitably and safely.",
   "roles": [
    {
     "title": "Hotel Operations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can design and operate high-quality travel, hospitality and event experiences profitably and safely."
    },
    {
     "title": "Revenue Manager - Hospitality",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can design and operate high-quality travel, hospitality and event experiences profitably and safely."
    },
    {
     "title": "Guest Relations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can design and operate high-quality travel, hospitality and event experiences profitably and safely."
    },
    {
     "title": "Food & Beverage Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can design and operate high-quality travel, hospitality and event experiences profitably and safely."
    },
    {
     "title": "Restaurant Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can design and operate high-quality travel, hospitality and event experiences profitably and safely."
    },
    {
     "title": "Travel Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can design and operate high-quality travel, hospitality and event experiences profitably and safely."
    },
    {
     "title": "Destination Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can design and operate high-quality travel, hospitality and event experiences profitably and safely."
    },
    {
     "title": "Event Producer",
     "aliases": [],
     "family": "Design / Creative / Production",
     "marketSignal": "High-growth / expanding",
     "purpose": "Research, design and deliver experiences or creative outputs that help the organisation design and operate high-quality travel, hospitality and event experiences profitably and safely."
    },
    {
     "title": "Event Operations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can design and operate high-quality travel, hospitality and event experiences profitably and safely."
    },
    {
     "title": "Wedding Planner",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Experience Designer - Hospitality",
     "aliases": [],
     "family": "Design / Creative / Production",
     "marketSignal": "Established / evolving",
     "purpose": "Research, design and deliver experiences or creative outputs that help the organisation design and operate high-quality travel, hospitality and event experiences profitably and safely."
    },
    {
     "title": "Hospitality Sales Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can design and operate high-quality travel, hospitality and event experiences profitably and safely."
    },
    {
     "title": "Culinary Operations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can design and operate high-quality travel, hospitality and event experiences profitably and safely."
    },
    {
     "title": "Tourism Product Manager",
     "aliases": [],
     "family": "Product Management",
     "marketSignal": "Established / evolving",
     "purpose": "Own product outcomes, prioritization and cross-functional delivery so the organisation can design and operate high-quality travel, hospitality and event experiences profitably and safely."
    }
   ]
  },
  {
   "order": 30,
   "name": "Education, Learning, Research & EdTech",
   "summary": "Design and deliver effective learning, curriculum and education experiences with measurable outcomes.",
   "roles": [
    {
     "title": "Teacher - Primary / Secondary",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Tertiary Educator / Lecturer",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "School Counselor",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can design and deliver effective learning, curriculum and education experiences with measurable outcomes."
    },
    {
     "title": "Curriculum Developer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to design and deliver effective learning, curriculum and education experiences with measurable outcomes."
    },
    {
     "title": "Instructional Designer",
     "aliases": [],
     "family": "Design / Creative / Production",
     "marketSignal": "Established / evolving",
     "purpose": "Research, design and deliver experiences or creative outputs that help the organisation design and deliver effective learning, curriculum and education experiences with measurable outcomes."
    },
    {
     "title": "Learning Experience Designer",
     "aliases": [],
     "family": "Design / Creative / Production",
     "marketSignal": "Established / evolving",
     "purpose": "Research, design and deliver experiences or creative outputs that help the organisation design and deliver effective learning, curriculum and education experiences with measurable outcomes."
    },
    {
     "title": "EdTech Product Manager",
     "aliases": [],
     "family": "Product Management",
     "marketSignal": "Established / evolving",
     "purpose": "Own product outcomes, prioritization and cross-functional delivery so the organisation can design and deliver effective learning, curriculum and education experiences with measurable outcomes."
    },
    {
     "title": "AI Learning Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Emerging / rapidly formalising",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can design and deliver effective learning, curriculum and education experiences with measurable outcomes."
    },
    {
     "title": "Corporate Trainer",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "High-growth / expanding",
     "purpose": ""
    },
    {
     "title": "Academic Program Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can design and deliver effective learning, curriculum and education experiences with measurable outcomes."
    },
    {
     "title": "Education Data Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "High-growth / expanding",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation design and deliver effective learning, curriculum and education experiences with measurable outcomes."
    },
    {
     "title": "Learning Analytics Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can design and deliver effective learning, curriculum and education experiences with measurable outcomes."
    },
    {
     "title": "Student Success Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can design and deliver effective learning, curriculum and education experiences with measurable outcomes."
    },
    {
     "title": "Education Technology Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can design and deliver effective learning, curriculum and education experiences with measurable outcomes."
    }
   ]
  },
  {
   "order": 31,
   "name": "Public Sector, International Development & Social Impact",
   "summary": "Design and deliver public-value programs, policy and digital services with accountability and inclusion.",
   "roles": [
    {
     "title": "Public Policy Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation design and deliver public-value programs, policy and digital services with accountability and inclusion."
    },
    {
     "title": "Program Officer",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can design and deliver public-value programs, policy and digital services with accountability and inclusion."
    },
    {
     "title": "Public Sector Consultant",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can design and deliver public-value programs, policy and digital services with accountability and inclusion."
    },
    {
     "title": "Social Impact Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can design and deliver public-value programs, policy and digital services with accountability and inclusion."
    },
    {
     "title": "Monitoring & Evaluation Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "High-growth / expanding",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can design and deliver public-value programs, policy and digital services with accountability and inclusion."
    },
    {
     "title": "Development Economist",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "High-growth / expanding",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation design and deliver public-value programs, policy and digital services with accountability and inclusion."
    },
    {
     "title": "Digital Public Infrastructure Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Emerging / rapidly formalising",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can design and deliver public-value programs, policy and digital services with accountability and inclusion."
    },
    {
     "title": "Civic Technology Product Manager",
     "aliases": [],
     "family": "Product Management",
     "marketSignal": "Established / evolving",
     "purpose": "Own product outcomes, prioritization and cross-functional delivery so the organisation can design and deliver public-value programs, policy and digital services with accountability and inclusion."
    },
    {
     "title": "Grant Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can design and deliver public-value programs, policy and digital services with accountability and inclusion."
    },
    {
     "title": "Urban Governance Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can design and deliver public-value programs, policy and digital services with accountability and inclusion."
    },
    {
     "title": "Public Health Program Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can design and deliver public-value programs, policy and digital services with accountability and inclusion."
    },
    {
     "title": "Humanitarian Program Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can design and deliver public-value programs, policy and digital services with accountability and inclusion."
    },
    {
     "title": "Government Digital Transformation Lead",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can design and deliver public-value programs, policy and digital services with accountability and inclusion."
    },
    {
     "title": "Public Procurement Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can design and deliver public-value programs, policy and digital services with accountability and inclusion."
    }
   ]
  },
  {
   "order": 32,
   "name": "Media, Gaming, Creator Economy & Entertainment",
   "summary": "Create, distribute and monetize compelling interactive and digital media experiences.",
   "roles": [
    {
     "title": "Game Developer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create, distribute and monetize compelling interactive and digital media experiences."
    },
    {
     "title": "Game Designer",
     "aliases": [],
     "family": "Design / Creative / Production",
     "marketSignal": "Established / evolving",
     "purpose": "Research, design and deliver experiences or creative outputs that help the organisation create, distribute and monetize compelling interactive and digital media experiences."
    },
    {
     "title": "Technical Artist",
     "aliases": [],
     "family": "Design / Creative / Production",
     "marketSignal": "Established / evolving",
     "purpose": "Research, design and deliver experiences or creative outputs that help the organisation create, distribute and monetize compelling interactive and digital media experiences."
    },
    {
     "title": "3D Artist",
     "aliases": [],
     "family": "Design / Creative / Production",
     "marketSignal": "Established / evolving",
     "purpose": "Research, design and deliver experiences or creative outputs that help the organisation create, distribute and monetize compelling interactive and digital media experiences."
    },
    {
     "title": "Virtual Production Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can create, distribute and monetize compelling interactive and digital media experiences."
    },
    {
     "title": "VFX Producer",
     "aliases": [],
     "family": "Design / Creative / Production",
     "marketSignal": "Established / evolving",
     "purpose": "Research, design and deliver experiences or creative outputs that help the organisation create, distribute and monetize compelling interactive and digital media experiences."
    },
    {
     "title": "Digital Content Producer",
     "aliases": [],
     "family": "Design / Creative / Production",
     "marketSignal": "Established / evolving",
     "purpose": "Research, design and deliver experiences or creative outputs that help the organisation create, distribute and monetize compelling interactive and digital media experiences."
    },
    {
     "title": "Creator Partnerships Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create, distribute and monetize compelling interactive and digital media experiences."
    },
    {
     "title": "Streaming Operations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create, distribute and monetize compelling interactive and digital media experiences."
    },
    {
     "title": "Media Data Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "High-growth / expanding",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation create, distribute and monetize compelling interactive and digital media experiences."
    },
    {
     "title": "Content Operations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create, distribute and monetize compelling interactive and digital media experiences."
    },
    {
     "title": "Audience Development Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create, distribute and monetize compelling interactive and digital media experiences."
    },
    {
     "title": "Rights & Licensing Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create, distribute and monetize compelling interactive and digital media experiences."
    },
    {
     "title": "Interactive Experience Designer",
     "aliases": [],
     "family": "Design / Creative / Production",
     "marketSignal": "Established / evolving",
     "purpose": "Research, design and deliver experiences or creative outputs that help the organisation create, distribute and monetize compelling interactive and digital media experiences."
    }
   ]
  },
  {
   "order": 33,
   "name": "Science, Deep Tech, Quantum & Advanced R&D",
   "summary": "Create new knowledge and technologies through rigorous experimentation, computation and translational r&d.",
   "roles": [
    {
     "title": "Research Scientist",
     "aliases": [],
     "family": "Research & Applied Science",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Research Engineer",
     "aliases": [],
     "family": "Research & Applied Science",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Computational Scientist",
     "aliases": [],
     "family": "Research & Applied Science",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Materials Scientist",
     "aliases": [],
     "family": "Research & Applied Science",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Chemist",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Physicist",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Established / evolving",
     "purpose": ""
    },
    {
     "title": "Quantum Computing Researcher",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "Emerging / rapidly formalising",
     "purpose": ""
    },
    {
     "title": "Quantum Software Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Emerging / rapidly formalising",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create new knowledge and technologies through rigorous experimentation, computation and translational R&D."
    },
    {
     "title": "Scientific Software Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create new knowledge and technologies through rigorous experimentation, computation and translational R&D."
    },
    {
     "title": "Laboratory Automation Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "High-growth / expanding",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can create new knowledge and technologies through rigorous experimentation, computation and translational R&D."
    },
    {
     "title": "Nanotechnology Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create new knowledge and technologies through rigorous experimentation, computation and translational R&D."
    },
    {
     "title": "Photonics Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to create new knowledge and technologies through rigorous experimentation, computation and translational R&D."
    },
    {
     "title": "R&D Program Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create new knowledge and technologies through rigorous experimentation, computation and translational R&D."
    },
    {
     "title": "Technology Transfer Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can create new knowledge and technologies through rigorous experimentation, computation and translational R&D."
    }
   ]
  },
  {
   "order": 34,
   "name": "Skilled Trades, Field Service & Asset Maintenance",
   "summary": "Install, inspect, repair and maintain critical physical assets safely and reliably.",
   "roles": [
    {
     "title": "Electrician",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to install, inspect, repair and maintain critical physical assets safely and reliably."
    },
    {
     "title": "HVAC Technician",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to install, inspect, repair and maintain critical physical assets safely and reliably."
    },
    {
     "title": "Industrial Maintenance Technician",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to install, inspect, repair and maintain critical physical assets safely and reliably."
    },
    {
     "title": "Welder",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to install, inspect, repair and maintain critical physical assets safely and reliably."
    },
    {
     "title": "Plumber",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to install, inspect, repair and maintain critical physical assets safely and reliably."
    },
    {
     "title": "Field Service Engineer",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to install, inspect, repair and maintain critical physical assets safely and reliably."
    },
    {
     "title": "Instrumentation Technician",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to install, inspect, repair and maintain critical physical assets safely and reliably."
    },
    {
     "title": "Renewable Energy Technician",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to install, inspect, repair and maintain critical physical assets safely and reliably."
    },
    {
     "title": "Elevator / Lift Technician",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "High-growth / expanding",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to install, inspect, repair and maintain critical physical assets safely and reliably."
    },
    {
     "title": "Maintenance Planner",
     "aliases": [],
     "family": "Professional / Operations",
     "marketSignal": "High-growth / expanding",
     "purpose": ""
    },
    {
     "title": "Heavy Equipment Technician",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to install, inspect, repair and maintain critical physical assets safely and reliably."
    },
    {
     "title": "Facilities Technician",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to install, inspect, repair and maintain critical physical assets safely and reliably."
    },
    {
     "title": "Lineworker / Powerline Technician",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to install, inspect, repair and maintain critical physical assets safely and reliably."
    },
    {
     "title": "Machinist / CNC Technician",
     "aliases": [],
     "family": "Engineering / Technical Delivery",
     "marketSignal": "Established / evolving",
     "purpose": "Design, build, validate and operate the systems or technical capabilities required to install, inspect, repair and maintain critical physical assets safely and reliably."
    }
   ]
  },
  {
   "order": 35,
   "name": "Customer Service, Shared Services & Enterprise Operations",
   "summary": "Deliver reliable, efficient enterprise and customer operations at scale.",
   "roles": [
    {
     "title": "Customer Support Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can deliver reliable, efficient enterprise and customer operations at scale."
    },
    {
     "title": "Contact Center Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can deliver reliable, efficient enterprise and customer operations at scale."
    },
    {
     "title": "Customer Experience Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation deliver reliable, efficient enterprise and customer operations at scale."
    },
    {
     "title": "Knowledge Management Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can deliver reliable, efficient enterprise and customer operations at scale."
    },
    {
     "title": "Shared Services Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can deliver reliable, efficient enterprise and customer operations at scale."
    },
    {
     "title": "Order Management Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can deliver reliable, efficient enterprise and customer operations at scale."
    },
    {
     "title": "Procure-to-Pay Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can deliver reliable, efficient enterprise and customer operations at scale."
    },
    {
     "title": "Order-to-Cash Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can deliver reliable, efficient enterprise and customer operations at scale."
    },
    {
     "title": "Record-to-Report Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can deliver reliable, efficient enterprise and customer operations at scale."
    },
    {
     "title": "Payroll Specialist",
     "aliases": [],
     "family": "Advisory / Specialist",
     "marketSignal": "Established / evolving",
     "purpose": "Provide specialist expertise, controls and execution support so the organisation can deliver reliable, efficient enterprise and customer operations at scale."
    },
    {
     "title": "Business Services Automation Lead",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "High-growth / expanding",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can deliver reliable, efficient enterprise and customer operations at scale."
    },
    {
     "title": "Workforce Management Analyst",
     "aliases": [],
     "family": "Analytics / Decision Support",
     "marketSignal": "Established / evolving",
     "purpose": "Use data, models and domain evidence to improve decisions and help the organisation deliver reliable, efficient enterprise and customer operations at scale."
    },
    {
     "title": "Service Operations Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can deliver reliable, efficient enterprise and customer operations at scale."
    },
    {
     "title": "Business Continuity Manager",
     "aliases": [],
     "family": "Management / Functional Leadership",
     "marketSignal": "Established / evolving",
     "purpose": "Lead strategy, people, governance and execution for the function so the organisation can deliver reliable, efficient enterprise and customer operations at scale."
    }
   ]
  }
 ]
};
