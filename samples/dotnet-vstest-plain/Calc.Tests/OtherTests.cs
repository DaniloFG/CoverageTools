using NUnit.Framework;

namespace Calc.Tests
{
    public class OtherTests
    {
        [TestCase(6, 3, 2)]
        public void DividesTwoNumbers(int a, int b, int expected)
        {
            Assert.That(Calculator.Divide(a, b), Is.EqualTo(expected));
        }
    }
}
