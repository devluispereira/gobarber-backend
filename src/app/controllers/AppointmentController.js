import * as Yup from 'yup';
import { isBefore, parseISO, startOfHour, format, subHours } from 'date-fns';
import pt from 'date-fns/locale/pt';

import Appointment from '../models/Appointment';
import User from '../models/User';
import File from '../models/File';
import Notification from '../schemas/Notification';

import Queues from '../../lib/Queues';

import CancelationMail from '../jobs/CancelationMail';

class AppointmentController {
  async store(req, res) {
    const schema = Yup.object().shape({
      date: Yup.date().required(),
      provider_id: Yup.number().required(),
    });

    if (!(await schema.isValid(req.body))) {
      return res.status(400).json({ error: 'Validate Fails' });
    }

    const { provider_id, date } = req.body;

    if (provider_id === req.userId) {
      return res
        .status(401)
        .json({ error: 'provider user cannot create schedule for himself' });
    }

    /**
     * Check if provider_id exist or is a providder
     */
    const userProvider = await User.findOne({
      where: { id: provider_id, provider: true },
    });

    if (!userProvider) {
      return res
        .status(401)
        .json({ error: 'You can only create appointment with provider' });
    }

    const hourStart = startOfHour(parseISO(date));
    /**
     * Checando se a data não é antes do dia de hoje
     */

    if (isBefore(hourStart, new Date())) {
      return res.status(400).json({ error: 'Past date are not permitted' });
    }

    /**
     * Chegando se a data está disponível
     */
    const checkAvailability = await Appointment.findOne({
      where: { provider_id, canceled_at: null, date: hourStart },
    });

    if (checkAvailability) {
      return res
        .status(400)
        .json({ error: 'Appointment date is not available' });
    }

    const appointment = await Appointment.create({
      user_id: req.userId,
      provider_id,
      date: hourStart,
    });

    /**
     * Notify appointment Provider
     *
     */
    const user = await User.findByPk(req.userId);

    const formattedDate = format(
      hourStart,
      "'dia' dd 'de' MMMM ,'as' H:mm'h'",
      { locale: pt }
    );

    await Notification.create({
      content: `Novo Agendamento de ${user.name} para o  ${formattedDate}`,
      user: provider_id,
    });

    return res.json(appointment);
  }

  async index(req, res) {
    const { page = 1 } = req.query;

    const appointment = await Appointment.findAll({
      where: {
        user_id: req.userId,
        canceled_at: null,
      },
      order: ['date'],
      attributes: ['id', 'date', 'past', 'canceleble'],
      limit: 20,
      offset: (page - 1) * 20,
      include: [
        {
          model: User,
          as: 'provider',
          attributes: ['id', 'name'],
          include: [
            {
              model: File,
              as: 'avatar',
              attributes: ['id', 'path', 'url'],
            },
          ],
        },
      ],
    });
    return res.json(appointment);
  }

  async delete(req, res) {
    const appointment = await Appointment.findByPk(req.params.id, {
      include: [
        {
          model: User,
          as: 'provider',
          attributes: ['name', 'email'],
        },
        { model: User, as: 'user', attributes: ['name'] },
      ],
    });

    if (appointment.user_id !== req.userId) {
      return res.status(401).json({
        error: 'You dont have permission to cancel this appointment',
      });
    }
    const dateWithSub = subHours(appointment.date, 2);

    if (isBefore(dateWithSub, new Date())) {
      return res
        .status(401)
        .json({ error: 'You can only cancell appointment 2 hours in advance' });
    }

    appointment.canceled_at = new Date();

    appointment.save();

    Queues.add(CancelationMail.key, {
      appointment,
    });

    return res.json(appointment);
  }
}

export default new AppointmentController();
